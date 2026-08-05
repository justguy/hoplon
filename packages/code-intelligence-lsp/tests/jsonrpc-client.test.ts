/**
 * tests/jsonrpc-client.test.ts — Unit tests for JsonRpcLspClient / createLspProvider.
 *
 * All tests use stubbed connectionFactory and spawnFn options — no vscode-jsonrpc
 * import required, no real LSP server is started.
 *
 * Tests:
 *   LSP2-1   createLspProvider returns a JsonRpcLspClient instance
 *   LSP2-2   Returned object has resolveSignature, resolveImport, findReferences, dispose
 *   LSP2-3   Structurally satisfies LspProvider seam (correct method arity)
 *   LSP2-4   resolveSignature delegates to connection.sendRequest with correct params
 *   LSP2-5   resolveSignature maps RawSignatureHelp → LspSignatureResult correctly
 *   LSP2-6   resolveSignature returns undefined when server returns null
 *   LSP2-7   resolveSignature returns undefined when signatures array is empty
 *   LSP2-8   resolveSignature maps parameter label byte offsets to string slices
 *   LSP2-9   resolveImport delegates to sendRequest and maps RawLocation
 *   LSP2-10  resolveImport handles Location[] (uses first element)
 *   LSP2-11  resolveImport returns undefined when server returns null
 *   LSP2-12  findReferences maps RawLocation[] to LspReferenceResult[]
 *   LSP2-13  findReferences returns [] when server returns null
 *   LSP2-14  dispose sends shutdown + exit, disposes connection
 *   LSP2-15  dispose is idempotent (second call is safe)
 *   LSP2-16  spawnFn override is used (real spawn never called)
 *   LSP2-17  serverArgs defaults to ['--stdio'] when not supplied
 *   LSP2-18  Lazy init: spawnFn NOT called at construction time
 *   LSP2-19  resolveSignature: object-form documentation { value } is unwrapped
 *   LSP2-20  createLspProvider accepts serverArgs override
 *   LSP2-21  Integration test (opt-in RUN_INTEGRATION=1): real typescript-language-server
 */

import { describe, it, expect, vi } from 'vitest';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { Readable, Writable } from 'node:stream';

import {
  createLspProvider,
  JsonRpcLspClient,
  type JsonRpcLspClientOptions,
  type MessageConnectionLike,
} from '../src/index.js';

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

/**
 * Fake ChildProcess — has stdout/stdin streams but never emits data.
 */
function createFakeProcess(): ChildProcessWithoutNullStreams {
  const proc = new EventEmitter() as unknown as ChildProcessWithoutNullStreams;
  (proc as unknown as Record<string, unknown>).stdout = new Readable({ read() {} });
  (proc as unknown as Record<string, unknown>).stdin = new Writable({ write(_c, _e, cb) { cb(); } });
  (proc as unknown as Record<string, unknown>).kill = vi.fn(() => true);
  return proc;
}

interface StubCall {
  method: string;
  params: unknown;
}

/**
 * Create a stub MessageConnectionLike with pre-programmed responses.
 * Records all sendRequest and sendNotification calls.
 */
function createStubConnection(responses: Record<string, unknown>): MessageConnectionLike & {
  calls: StubCall[];
  notificationCalls: StubCall[];
  dispose: ReturnType<typeof vi.fn>;
} {
  const calls: StubCall[] = [];
  const notificationCalls: StubCall[] = [];
  const dispose = vi.fn();

  return {
    calls,
    notificationCalls,
    dispose,
    listen: vi.fn(),
    sendRequest: vi.fn(async (method: string, params: unknown) => {
      calls.push({ method, params });
      return Object.prototype.hasOwnProperty.call(responses, method)
        ? responses[method]
        : null;
    }) as MessageConnectionLike['sendRequest'],
    sendNotification: vi.fn((method: string, params: unknown) => {
      notificationCalls.push({ method, params });
    }),
  };
}

type BoundStub = ReturnType<typeof createStubConnection>;

/**
 * Create a JsonRpcLspClient with a stubbed connectionFactory and spawnFn.
 * The connectionFactory returns the stub directly, bypassing vscode-jsonrpc.
 */
function createStubbedClient(
  responses: Record<string, unknown> = {},
  extraOpts: Partial<JsonRpcLspClientOptions> = {},
): { client: JsonRpcLspClient; stub: BoundStub } {
  const stub = createStubConnection(responses);

  const client = new JsonRpcLspClient({
    serverCommand: 'fake-lsp',
    spawnFn: () => createFakeProcess(),
    connectionFactory: () => stub,
    ...extraOpts,
  });

  return { client, stub };
}

// ---------------------------------------------------------------------------
// LSP2-1 — createLspProvider returns a JsonRpcLspClient
// ---------------------------------------------------------------------------

describe('LSP2-1 — createLspProvider returns a JsonRpcLspClient', () => {
  it('returns an instance of JsonRpcLspClient', () => {
    const provider = createLspProvider({ serverCommand: 'fake-lsp' });
    expect(provider).toBeInstanceOf(JsonRpcLspClient);
  });
});

// ---------------------------------------------------------------------------
// LSP2-2 — Returned object has required methods
// ---------------------------------------------------------------------------

describe('LSP2-2 — returned object has all LspProvider methods + dispose', () => {
  it('has resolveSignature, resolveImport, findReferences, and dispose', () => {
    const provider = createLspProvider({ serverCommand: 'fake-lsp' });
    expect(typeof provider.resolveSignature).toBe('function');
    expect(typeof provider.resolveImport).toBe('function');
    expect(typeof provider.findReferences).toBe('function');
    expect(typeof provider.dispose).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// LSP2-3 — Structurally satisfies LspProvider seam
// ---------------------------------------------------------------------------

describe('LSP2-3 — structurally satisfies LspProvider seam interface', () => {
  it('resolveSignature has arity 2 (file, position)', () => {
    const provider = createLspProvider({ serverCommand: 'fake-lsp' });
    expect(provider.resolveSignature.length).toBe(2);
  });

  it('resolveImport has arity 2 (file, specifier)', () => {
    const provider = createLspProvider({ serverCommand: 'fake-lsp' });
    expect(provider.resolveImport.length).toBe(2);
  });

  it('findReferences has arity 2 (file, symbol)', () => {
    const provider = createLspProvider({ serverCommand: 'fake-lsp' });
    expect(provider.findReferences.length).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// LSP2-4 — resolveSignature sends correct LSP request params
// ---------------------------------------------------------------------------

describe('LSP2-4 — resolveSignature sends textDocument/signatureHelp with correct params', () => {
  it('includes the encoded file URI and position in the request', async () => {
    const { client, stub } = createStubbedClient({
      'textDocument/signatureHelp': {
        signatures: [{ label: 'fn(): void', parameters: [] }],
        activeSignature: 0,
      },
    });

    await client.resolveSignature('/project/src/main.ts', { line: 5, character: 10 });

    const sigCall = stub.calls.find((c) => c.method === 'textDocument/signatureHelp');
    expect(sigCall).toBeDefined();
    const params = sigCall!.params as {
      textDocument: { uri: string };
      position: { line: number; character: number };
    };
    expect(params.textDocument.uri).toContain('main.ts');
    expect(params.position.line).toBe(5);
    expect(params.position.character).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// LSP2-5 — resolveSignature maps RawSignatureHelp → LspSignatureResult
// ---------------------------------------------------------------------------

describe('LSP2-5 — resolveSignature maps RawSignatureHelp correctly', () => {
  it('maps label, string parameters, and documentation', async () => {
    const { client } = createStubbedClient({
      'textDocument/signatureHelp': {
        signatures: [
          {
            label: 'Array.from<T>(arrayLike: ArrayLike<T>): T[]',
            parameters: [{ label: 'arrayLike: ArrayLike<T>' }],
            documentation: 'Creates an array from an array-like object.',
          },
        ],
        activeSignature: 0,
      },
    });

    const result = await client.resolveSignature('/src/main.ts', { line: 0, character: 0 });
    expect(result).toBeDefined();
    expect(result!.label).toBe('Array.from<T>(arrayLike: ArrayLike<T>): T[]');
    expect(result!.parameters).toEqual(['arrayLike: ArrayLike<T>']);
    expect(result!.documentation).toBe('Creates an array from an array-like object.');
  });

  it('uses activeSignature index to pick the correct overload', async () => {
    const { client } = createStubbedClient({
      'textDocument/signatureHelp': {
        signatures: [
          { label: 'first(): void', parameters: [] },
          { label: 'second(x: number): string', parameters: [{ label: 'x: number' }] },
        ],
        activeSignature: 1,
      },
    });

    const result = await client.resolveSignature('/src/main.ts', { line: 0, character: 0 });
    expect(result!.label).toBe('second(x: number): string');
    expect(result!.parameters).toEqual(['x: number']);
  });
});

// ---------------------------------------------------------------------------
// LSP2-6 — resolveSignature returns undefined for null response
// ---------------------------------------------------------------------------

describe('LSP2-6 — resolveSignature returns undefined when server returns null', () => {
  it('returns undefined for a null SignatureHelp response', async () => {
    const { client } = createStubbedClient({ 'textDocument/signatureHelp': null });
    const result = await client.resolveSignature('/src/main.ts', { line: 0, character: 0 });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LSP2-7 — resolveSignature returns undefined for empty signatures array
// ---------------------------------------------------------------------------

describe('LSP2-7 — resolveSignature returns undefined when signatures is []', () => {
  it('returns undefined when signatures array is empty', async () => {
    const { client } = createStubbedClient({
      'textDocument/signatureHelp': { signatures: [], activeSignature: 0 },
    });
    const result = await client.resolveSignature('/src/main.ts', { line: 0, character: 0 });
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LSP2-8 — resolveSignature maps [start, end] parameter labels to string slices
// ---------------------------------------------------------------------------

describe('LSP2-8 — resolveSignature maps [start,end] offset labels to slices', () => {
  it('extracts parameter label from sig.label using byte offsets', async () => {
    // sig.label = "fn(x: number): void"
    //              0         1
    //              0123456789012345678
    // "x: number" starts at 3, ends at 12 (exclusive) → slice(3, 12) = "x: number"
    const { client } = createStubbedClient({
      'textDocument/signatureHelp': {
        signatures: [
          {
            label: 'fn(x: number): void',
            parameters: [{ label: [3, 12] }],
          },
        ],
        activeSignature: 0,
      },
    });

    const result = await client.resolveSignature('/src/fn.ts', { line: 1, character: 2 });
    expect(result).toBeDefined();
    expect(result!.parameters).toEqual(['x: number']);
  });
});

// ---------------------------------------------------------------------------
// LSP2-9 — resolveImport maps RawLocation to resolvedPath + byteRange
// ---------------------------------------------------------------------------

describe('LSP2-9 — resolveImport maps single RawLocation response', () => {
  it('maps uri to resolvedPath and range to byteRange', async () => {
    const { client, stub } = createStubbedClient({
      'textDocument/definition': {
        uri: 'file:///project/src/utils.ts',
        range: {
          start: { line: 0, character: 0 },
          end: { line: 0, character: 5 },
        },
      },
    });

    const result = await client.resolveImport('/project/src/main.ts', './utils');
    expect(result).toBeDefined();
    expect(result!.resolvedPath).toBe('/project/src/utils.ts');
    expect(result!.byteRange).toHaveLength(2);

    const defCall = stub.calls.find((c) => c.method === 'textDocument/definition');
    expect(defCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LSP2-10 — resolveImport handles Location[] (uses first element)
// ---------------------------------------------------------------------------

describe('LSP2-10 — resolveImport uses first element from Location[]', () => {
  it('picks the first location from an array response', async () => {
    const { client } = createStubbedClient({
      'textDocument/definition': [
        {
          uri: 'file:///project/src/utils.ts',
          range: { start: { line: 10, character: 0 }, end: { line: 10, character: 15 } },
        },
        {
          uri: 'file:///project/src/other.ts',
          range: { start: { line: 0, character: 0 }, end: { line: 0, character: 0 } },
        },
      ],
    });

    const result = await client.resolveImport('/project/src/main.ts', './utils');
    expect(result).toBeDefined();
    expect(result!.resolvedPath).toBe('/project/src/utils.ts');
  });
});

// ---------------------------------------------------------------------------
// LSP2-11 — resolveImport returns undefined for null response
// ---------------------------------------------------------------------------

describe('LSP2-11 — resolveImport returns undefined for null response', () => {
  it('returns undefined when definition response is null', async () => {
    const { client } = createStubbedClient({ 'textDocument/definition': null });
    const result = await client.resolveImport('/src/main.ts', './nonexistent');
    expect(result).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LSP2-12 — findReferences maps RawLocation[] → LspReferenceResult[]
// ---------------------------------------------------------------------------

describe('LSP2-12 — findReferences maps RawLocation[] correctly', () => {
  it('maps each location to { path, byteRange }', async () => {
    const { client, stub } = createStubbedClient({
      'textDocument/references': [
        {
          uri: 'file:///project/src/engine.ts',
          range: { start: { line: 5, character: 2 }, end: { line: 5, character: 16 } },
        },
        {
          uri: 'file:///project/tests/engine.test.ts',
          range: { start: { line: 20, character: 0 }, end: { line: 20, character: 14 } },
        },
      ],
    });

    const results = await client.findReferences('/project/src/engine.ts', 'createSnapshot');
    expect(results).toHaveLength(2);
    expect(results[0]!.path).toBe('/project/src/engine.ts');
    expect(results[1]!.path).toBe('/project/tests/engine.test.ts');

    const refCall = stub.calls.find((c) => c.method === 'textDocument/references');
    expect(refCall).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// LSP2-13 — findReferences returns [] for null response
// ---------------------------------------------------------------------------

describe('LSP2-13 — findReferences returns [] when server returns null', () => {
  it('returns empty array for null references response', async () => {
    const { client } = createStubbedClient({ 'textDocument/references': null });
    const results = await client.findReferences('/src/main.ts', 'unknownSymbol');
    expect(results).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// LSP2-14 — dispose sends shutdown + exit + disposes connection
// ---------------------------------------------------------------------------

describe('LSP2-14 — dispose sends shutdown + exit and disposes connection', () => {
  it('calls shutdown request, exit notification, and dispose', async () => {
    const { client, stub } = createStubbedClient({ shutdown: null });

    // Trigger init via a method call
    await client.resolveSignature('/a.ts', { line: 0, character: 0 });
    await client.dispose();

    const shutdownCall = stub.calls.find((c) => c.method === 'shutdown');
    expect(shutdownCall).toBeDefined();

    const exitCall = stub.notificationCalls.find((c) => c.method === 'exit');
    expect(exitCall).toBeDefined();

    expect(stub.dispose).toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// LSP2-15 — dispose is idempotent
// ---------------------------------------------------------------------------

describe('LSP2-15 — dispose is idempotent', () => {
  it('second dispose() resolves without throwing', async () => {
    const { client } = createStubbedClient({ shutdown: null });
    await client.resolveSignature('/a.ts', { line: 0, character: 0 });
    await client.dispose();
    await expect(client.dispose()).resolves.toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// LSP2-16 — spawnFn override prevents real spawn
// ---------------------------------------------------------------------------

describe('LSP2-16 — spawnFn override is used (real spawn never called)', () => {
  it('custom spawnFn is invoked instead of real child_process.spawn', async () => {
    let spawnCount = 0;
    const customSpawn = () => {
      spawnCount++;
      return createFakeProcess();
    };
    const stub = createStubConnection({});

    const client = new JsonRpcLspClient({
      serverCommand: 'fake-lsp',
      spawnFn: customSpawn as JsonRpcLspClientOptions['spawnFn'],
      connectionFactory: () => stub,
    });

    await client.resolveSignature('/a.ts', { line: 0, character: 0 });
    expect(spawnCount).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// LSP2-17 — serverArgs defaults to ['--stdio']
// ---------------------------------------------------------------------------

describe('LSP2-17 — serverArgs defaults to --stdio when not supplied', () => {
  it('opts.serverArgs is ["--stdio"] when serverArgs is omitted', () => {
    const client = new JsonRpcLspClient({ serverCommand: 'fake-lsp' });
    expect(client.opts.serverArgs).toEqual(['--stdio']);
  });
});

// ---------------------------------------------------------------------------
// LSP2-18 — Lazy init: spawnFn not called at construction time
// ---------------------------------------------------------------------------

describe('LSP2-18 — lazy init: spawnFn NOT called at construction time', () => {
  it('spawnFn is not invoked during construction', () => {
    let spawnCount = 0;
    const customSpawn = () => {
      spawnCount++;
      return createFakeProcess();
    };

    new JsonRpcLspClient({
      serverCommand: 'fake-lsp',
      spawnFn: customSpawn as JsonRpcLspClientOptions['spawnFn'],
    });

    expect(spawnCount).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// LSP2-19 — resolveSignature unwraps MarkupContent { value } documentation
// ---------------------------------------------------------------------------

describe('LSP2-19 — resolveSignature unwraps MarkupContent documentation', () => {
  it('extracts .value from { kind, value } documentation object', async () => {
    const { client } = createStubbedClient({
      'textDocument/signatureHelp': {
        signatures: [
          {
            label: 'foo(x: string): void',
            parameters: [{ label: 'x: string' }],
            documentation: { kind: 'markdown', value: 'Detailed **markdown** docs.' },
          },
        ],
        activeSignature: 0,
      },
    });

    const result = await client.resolveSignature('/src/foo.ts', { line: 0, character: 0 });
    expect(result).toBeDefined();
    expect(result!.documentation).toBe('Detailed **markdown** docs.');
  });
});

// ---------------------------------------------------------------------------
// LSP2-20 — createLspProvider accepts custom serverArgs
// ---------------------------------------------------------------------------

describe('LSP2-20 — createLspProvider passes serverArgs to the client', () => {
  it('client opts.serverArgs matches the supplied serverArgs', () => {
    const provider = createLspProvider({
      serverCommand: 'fake-lsp',
      serverArgs: ['--stdio', '--log-level', 'error'],
    });
    expect(provider.opts.serverArgs).toEqual(['--stdio', '--log-level', 'error']);
  });
});

// ---------------------------------------------------------------------------
// LSP2-21 — Integration test (opt-in RUN_INTEGRATION=1)
// ---------------------------------------------------------------------------

describe('LSP2-21 — integration: real typescript-language-server (RUN_INTEGRATION=1 only)', () => {
  const shouldRun = process.env['RUN_INTEGRATION'] === '1';

  it.skipIf(!shouldRun)(
    'spawns real typescript-language-server and resolves a signature',
    async () => {
      // Check binary exists
      const { execFileSync } = await import('node:child_process');
      let binaryFound = false;
      try {
        execFileSync('typescript-language-server', ['--version'], { timeout: 3000 });
        binaryFound = true;
      } catch {
        binaryFound = false;
      }

      if (!binaryFound) {
        console.warn('LSP2-21: typescript-language-server not found on PATH — skipping.');
        return;
      }

      const { createLspProvider: createReal } = await import('../src/index.js');

      const rootUri = `file://${process.cwd()}`;
      const provider = createReal({
        serverCommand: 'typescript-language-server',
        serverArgs: ['--stdio'],
        rootUri,
      });

      try {
        // Resolve a signature at position (0, 0) — may return undefined (that's fine).
        // What we prove is the transport works end-to-end without throwing.
        const sig = await provider.resolveSignature(
          `${process.cwd()}/src/index.ts`,
          { line: 0, character: 0 },
        );
        if (sig !== undefined) {
          expect(typeof sig.label).toBe('string');
          expect(Array.isArray(sig.parameters)).toBe(true);
        }
      } finally {
        await provider.dispose();
      }
    },
    15_000, // 15 second timeout for real LSP startup
  );
});
