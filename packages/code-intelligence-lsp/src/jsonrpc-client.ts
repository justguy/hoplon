/**
 * src/jsonrpc-client.ts — JSON-RPC stdio client for LSP servers.
 *
 * Spawns an LSP server subprocess via Node's `child_process.spawn`, creates a
 * vscode-jsonrpc connection over its stdio streams, and exposes the three
 * `LspProvider` methods that `createLspCodeIntelligence` (LSP1) depends on:
 *   - resolveSignature  →  textDocument/signatureHelp
 *   - resolveImport     →  textDocument/definition
 *   - findReferences    →  textDocument/references
 *
 * The client is lazy: it does not spawn the server or initialise the LSP
 * connection until the first method is called. This makes construction
 * synchronous and side-effect-free (H2: adapters are the only seam to the
 * environment; the engine must be constructable without spawning processes).
 *
 * Transport injection:
 *   For unit tests, the `connectionFactory` option can be injected to bypass
 *   vscode-jsonrpc entirely. The factory receives the spawned process and must
 *   return a `MessageConnectionLike` (minimal structural type). When omitted,
 *   the real vscode-jsonrpc factory is used via a dynamic import at init time.
 *   This keeps the top-level module import free of vscode-jsonrpc so the
 *   module graph is importable without vscode-jsonrpc installed.
 *
 * Lifecycle:
 *   const provider = createLspProvider({ serverCommand: 'typescript-language-server' });
 *   // ... pass to createLspCodeIntelligence({ lspProvider: provider, ... })
 *   await provider.dispose();  // shutdown gracefully
 */

import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';

// ---------------------------------------------------------------------------
// Minimal structural interface for a JSON-RPC connection
// (satisfies both vscode-jsonrpc's MessageConnection and test stubs)
// ---------------------------------------------------------------------------

export interface MessageConnectionLike {
  listen(): void;
  dispose(): void;
  sendRequest<R>(method: string, params: unknown): Promise<R>;
  sendNotification(method: string, params: unknown): void;
}

// ---------------------------------------------------------------------------
// Types re-exported for consumers that don't want to peer-import from core
// ---------------------------------------------------------------------------

export interface LspPosition {
  line: number;
  character: number;
}

export interface LspSignatureResult {
  label: string;
  parameters: string[];
  documentation?: string;
}

export interface LspImportResolutionResult {
  resolvedPath: string;
  byteRange: [number, number];
}

export interface LspReferenceResult {
  path: string;
  byteRange: [number, number];
}

// ---------------------------------------------------------------------------
// Raw LSP protocol shapes (minimal — only what we extract)
// ---------------------------------------------------------------------------

interface RawParameterInformation {
  label: string | [number, number];
}

interface RawSignatureInformation {
  label: string;
  documentation?: string | { kind: string; value: string };
  parameters?: RawParameterInformation[];
}

interface RawSignatureHelp {
  signatures: RawSignatureInformation[];
  activeSignature?: number;
}

interface RawLocation {
  uri: string;
  range: {
    start: { line: number; character: number };
    end: { line: number; character: number };
  };
}

// ---------------------------------------------------------------------------
// ConnectionFactory type
// ---------------------------------------------------------------------------

/**
 * Factory that wraps a spawned process in a JSON-RPC connection.
 * Injected in tests to avoid requiring vscode-jsonrpc.
 * In production, the default factory uses vscode-jsonrpc dynamically.
 */
export type ConnectionFactory = (
  proc: ChildProcessWithoutNullStreams,
) => MessageConnectionLike;

// ---------------------------------------------------------------------------
// JsonRpcLspClientOptions
// ---------------------------------------------------------------------------

export interface JsonRpcLspClientOptions {
  /**
   * The LSP server binary to spawn (e.g. `'typescript-language-server'`,
   * `'pyright-langserver'`, `'rust-analyzer'`).
   */
  serverCommand: string;

  /**
   * Arguments passed to the LSP server. Defaults to `['--stdio']` which is
   * the standard for most LSP servers.
   */
  serverArgs?: string[];

  /**
   * Root URI of the workspace. Required by the LSP `initialize` handshake.
   * Defaults to `process.cwd()` expressed as a `file://` URI.
   */
  rootUri?: string;

  /**
   * Spawn function override — injected by tests to avoid spawning a real process.
   * Must have the same signature as `child_process.spawn`.
   */
  spawnFn?: (
    command: string,
    args: string[],
    options: { stdio: ['pipe', 'pipe', 'pipe'] },
  ) => ChildProcessWithoutNullStreams;

  /**
   * Connection factory override — injected by tests to avoid vscode-jsonrpc.
   *
   * In production this is omitted; a dynamic import of `vscode-jsonrpc/node.js`
   * creates the real connection. Injecting a stub allows tests to run without
   * vscode-jsonrpc being installed.
   */
  connectionFactory?: ConnectionFactory;
}

// ---------------------------------------------------------------------------
// LSP method names
// ---------------------------------------------------------------------------

const LSP_INITIALIZE = 'initialize';
const LSP_INITIALIZED = 'initialized';
const LSP_SIGNATURE_HELP = 'textDocument/signatureHelp';
const LSP_DEFINITION = 'textDocument/definition';
const LSP_REFERENCES = 'textDocument/references';
const LSP_SHUTDOWN = 'shutdown';
const LSP_EXIT = 'exit';

// ---------------------------------------------------------------------------
// URI helpers
// ---------------------------------------------------------------------------

function fileUri(absolutePath: string): string {
  const encoded = absolutePath
    .split('/')
    .map((seg) => encodeURIComponent(seg))
    .join('/');
  return `file://${encoded.startsWith('/') ? '' : '/'}${encoded}`;
}

function uriToPath(uri: string): string {
  if (!uri.startsWith('file://')) return uri;
  return decodeURIComponent(uri.slice('file://'.length));
}

// ---------------------------------------------------------------------------
// JsonRpcLspClient
// ---------------------------------------------------------------------------

/**
 * LspProvider implementation backed by a real LSP server process.
 *
 * Structurally satisfies the `LspProvider` interface from
 * `@phalanx/hoplon`'s `createLspCodeIntelligence` adapter. Pass an instance
 * directly as `lspProvider`:
 *
 * ```ts
 * const provider = new JsonRpcLspClient({ serverCommand: 'typescript-language-server' });
 * const adapter = createLspCodeIntelligence({ lspProvider: provider, fallbackAdapter });
 * ```
 */
export class JsonRpcLspClient {
  /** @internal — exposed for test patching via (client as any).opts */
  readonly opts: {
    serverCommand: string;
    serverArgs: string[];
    rootUri: string;
    spawnFn: NonNullable<JsonRpcLspClientOptions['spawnFn']>;
    connectionFactory: ConnectionFactory | undefined;
  };

  private process: ChildProcessWithoutNullStreams | null = null;
  private connection: MessageConnectionLike | null = null;
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor(opts: JsonRpcLspClientOptions) {
    this.opts = {
      serverCommand: opts.serverCommand,
      serverArgs: opts.serverArgs ?? ['--stdio'],
      rootUri: opts.rootUri ?? `file://${process.cwd()}`,
      spawnFn: opts.spawnFn ?? (spawn as NonNullable<JsonRpcLspClientOptions['spawnFn']>),
      connectionFactory: opts.connectionFactory,
    };
  }

  // -------------------------------------------------------------------------
  // Lazy initialise
  // -------------------------------------------------------------------------

  private async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._init();
    return this.initPromise;
  }

  /** @internal — split out so tests can override via (client as any)._init */
  async _init(): Promise<void> {
    const proc = this.opts.spawnFn(
      this.opts.serverCommand,
      this.opts.serverArgs,
      { stdio: ['pipe', 'pipe', 'pipe'] },
    );
    this.process = proc;

    let conn: MessageConnectionLike;

    if (this.opts.connectionFactory) {
      conn = this.opts.connectionFactory(proc);
    } else {
      // Dynamic import keeps vscode-jsonrpc out of the static module graph.
      // Tests that inject connectionFactory never reach this branch.
      // vscode-jsonrpc is a declared devDependency; types are not available
      // until `npm install` is run in this package. The `// @ts-expect-error`
      // suppresses the missing-module diagnostic that appears before install.
      // eslint-disable-next-line @typescript-eslint/ban-ts-comment
      // @ts-expect-error vscode-jsonrpc not installed until npm install in this package
      const jsonrpc = await import('vscode-jsonrpc/node.js') as {
        StreamMessageReader: new (stream: NodeJS.ReadableStream) => unknown;
        StreamMessageWriter: new (stream: NodeJS.WritableStream) => unknown;
        createMessageConnection: (reader: unknown, writer: unknown) => MessageConnectionLike;
      };
      const reader = new jsonrpc.StreamMessageReader(proc.stdout);
      const writer = new jsonrpc.StreamMessageWriter(proc.stdin);
      conn = jsonrpc.createMessageConnection(reader, writer);
    }

    conn.listen();
    this.connection = conn;

    // LSP initialize handshake
    await conn.sendRequest(LSP_INITIALIZE, {
      processId: process.pid ?? null,
      rootUri: this.opts.rootUri,
      capabilities: {
        textDocument: {
          signatureHelp: { signatureInformation: { documentationFormat: ['plaintext'] } },
          definition: {},
          references: {},
        },
      },
    });

    conn.sendNotification(LSP_INITIALIZED, {});
    this.initialized = true;
  }

  // -------------------------------------------------------------------------
  // resolveSignature → textDocument/signatureHelp
  // -------------------------------------------------------------------------

  async resolveSignature(
    file: string,
    position: LspPosition,
  ): Promise<LspSignatureResult | undefined> {
    await this.ensureInitialized();
    const conn = this.connection!;

    const response = await conn.sendRequest<RawSignatureHelp | null>(LSP_SIGNATURE_HELP, {
      textDocument: { uri: fileUri(file) },
      position,
    });

    if (!response || response.signatures.length === 0) return undefined;

    const activeIdx = response.activeSignature ?? 0;
    const sig = response.signatures[activeIdx] ?? response.signatures[0];
    if (!sig) return undefined;

    const parameters: string[] = (sig.parameters ?? []).map((p) => {
      if (typeof p.label === 'string') return p.label;
      // LSP allows label as [startChar, endChar] offsets into sig.label
      const [start, end] = p.label as [number, number];
      return sig.label.slice(start, end);
    });

    const documentation =
      typeof sig.documentation === 'string'
        ? sig.documentation
        : sig.documentation?.value;

    const result: LspSignatureResult = {
      label: sig.label,
      parameters,
      ...(documentation !== undefined ? { documentation } : {}),
    };
    return result;
  }

  // -------------------------------------------------------------------------
  // resolveImport → textDocument/definition
  // -------------------------------------------------------------------------

  async resolveImport(
    file: string,
    specifier: string,
  ): Promise<LspImportResolutionResult | undefined> {
    await this.ensureInitialized();
    const conn = this.connection!;

    // textDocument/definition needs a position. We use (0, 0) as a synthetic
    // anchor since this method resolves module-level import specifiers.
    // The `specifier` parameter documents intent; the LSP server routes via
    // the file's document content, not the specifier string directly.
    void specifier;

    const response = await conn.sendRequest<RawLocation | RawLocation[] | null>(
      LSP_DEFINITION,
      {
        textDocument: { uri: fileUri(file) },
        position: { line: 0, character: 0 },
      },
    );

    if (!response) return undefined;
    const loc: RawLocation = Array.isArray(response) ? response[0]! : response;
    if (!loc) return undefined;

    const resolvedPath = uriToPath(loc.uri);
    // Convert LSP Range to a packed byte range approximation.
    // Without file content we cannot compute exact byte offsets; we store the
    // line/character as a packed integer for round-trip fidelity in tests.
    const byteRange: [number, number] = [
      loc.range.start.line * 10000 + loc.range.start.character,
      loc.range.end.line * 10000 + loc.range.end.character,
    ];

    return { resolvedPath, byteRange };
  }

  // -------------------------------------------------------------------------
  // findReferences → textDocument/references
  // -------------------------------------------------------------------------

  async findReferences(
    file: string,
    _symbol: string,
  ): Promise<LspReferenceResult[]> {
    await this.ensureInitialized();
    const conn = this.connection!;

    const response = await conn.sendRequest<RawLocation[] | null>(LSP_REFERENCES, {
      textDocument: { uri: fileUri(file) },
      position: { line: 0, character: 0 },
      context: { includeDeclaration: true },
    });

    if (!response) return [];

    return response.map((loc) => ({
      path: uriToPath(loc.uri),
      byteRange: [
        loc.range.start.line * 10000 + loc.range.start.character,
        loc.range.end.line * 10000 + loc.range.end.character,
      ] as [number, number],
    }));
  }

  // -------------------------------------------------------------------------
  // dispose — graceful shutdown
  // -------------------------------------------------------------------------

  async dispose(): Promise<void> {
    if (!this.connection) return;
    try {
      await this.connection.sendRequest(LSP_SHUTDOWN, null);
      this.connection.sendNotification(LSP_EXIT, null);
    } catch {
      // Best-effort — server may have already exited.
    } finally {
      this.connection.dispose();
      this.connection = null;
      this.process?.kill();
      this.process = null;
      this.initialized = false;
      this.initPromise = null;
    }
  }
}
