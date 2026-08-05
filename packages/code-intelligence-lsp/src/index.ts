/**
 * @phalanx/hoplon-code-intelligence-lsp
 *
 * LSP server plugin for @phalanx/hoplon. Binds the `LspProvider` seam
 * (from LSP1 — `@phalanx/hoplon` adapter `createLspCodeIntelligence`) to a
 * real LSP server process via JSON-RPC over stdio.
 *
 * Public surface:
 *   createLspProvider({ serverCommand, serverArgs?, rootUri? })
 *     → LspProvider-compatible object (structurally satisfies the seam)
 *
 * Usage:
 * ```ts
 * import { createLspCodeIntelligence } from '@phalanx/hoplon';
 * import { createLspProvider } from '@phalanx/hoplon-code-intelligence-lsp';
 *
 * const lspProvider = createLspProvider({
 *   serverCommand: 'typescript-language-server',
 *   serverArgs: ['--stdio'],
 * });
 *
 * const adapter = createLspCodeIntelligence({
 *   lspProvider,
 *   fallbackAdapter: treeSitterAdapter,
 * });
 * ```
 *
 * The returned `lspProvider` is also a `JsonRpcLspClient` instance; call
 * `lspProvider.dispose()` when the engine shuts down to gracefully stop the
 * LSP server process.
 */

export { JsonRpcLspClient } from './jsonrpc-client.js';
export type {
  JsonRpcLspClientOptions,
  MessageConnectionLike,
  ConnectionFactory,
  LspPosition,
  LspSignatureResult,
  LspImportResolutionResult,
  LspReferenceResult,
} from './jsonrpc-client.js';

// ---------------------------------------------------------------------------
// createLspProvider — primary entry point
// ---------------------------------------------------------------------------

import { JsonRpcLspClient, type JsonRpcLspClientOptions } from './jsonrpc-client.js';

/**
 * Options for `createLspProvider`. A subset of `JsonRpcLspClientOptions`
 * exposed as the plugin's public API.
 */
export interface CreateLspProviderOptions {
  /**
   * The LSP server binary to spawn.
   * Examples: `'typescript-language-server'`, `'pyright-langserver'`, `'rust-analyzer'`.
   */
  serverCommand: string;

  /**
   * Arguments passed to the LSP server.
   * Defaults to `['--stdio']` (standard for most LSP servers).
   */
  serverArgs?: string[];

  /**
   * Root URI for the LSP workspace initialisation.
   * Defaults to `file://<cwd>`.
   */
  rootUri?: string;
}

/**
 * Create a `LspProvider`-compatible object that spawns the given LSP server
 * and communicates with it via JSON-RPC over stdio.
 *
 * The returned object satisfies the structural `LspProvider` interface from
 * `@phalanx/hoplon`'s `createLspCodeIntelligence` adapter — pass it directly
 * as `lspProvider`:
 *
 * ```ts
 * const lspProvider = createLspProvider({ serverCommand: 'typescript-language-server' });
 * const adapter = createLspCodeIntelligence({ lspProvider, fallbackAdapter: tsAdapter });
 * ```
 *
 * The server process is spawned lazily on the first method call. Call
 * `lspProvider.dispose()` at engine shutdown to terminate it gracefully.
 *
 * @param opts - Provider options.
 * @returns A `JsonRpcLspClient` instance (which implements `LspProvider` structurally).
 */
export function createLspProvider(opts: CreateLspProviderOptions): JsonRpcLspClient {
  const clientOpts: JsonRpcLspClientOptions = {
    serverCommand: opts.serverCommand,
    ...(opts.serverArgs !== undefined ? { serverArgs: opts.serverArgs } : {}),
    ...(opts.rootUri !== undefined ? { rootUri: opts.rootUri } : {}),
  };
  return new JsonRpcLspClient(clientOpts);
}
