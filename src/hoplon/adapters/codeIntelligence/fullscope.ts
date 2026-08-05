/**
 * adapters/codeIntelligence/fullscope.ts — Fullscope-backed CodeIntelligenceAdapter (t-030).
 *
 * Mirrors the LspProvider seam idiom from `lsp.ts`: the adapter depends on an
 * injected `FullscopeProvider` rather than on any specific MCP transport,
 * subprocess, or tpf-mcp binary. Real Fullscope-MCP wiring (spawning
 * `node .../tpf-mcp/index.js`, driving its JSON-RPC surface) lives outside the
 * core package, same pattern as LSP2 for the LSP adapter. This file proves the
 * seam shape only — no network, no subprocess, no new npm deps in core.
 *
 * Scope (honest, bounded):
 *   - Shipped default stays local tree-sitter. Binding this adapter is a host-
 *     opt-in constructor; the engine factory does not bind it automatically.
 *   - `parse` and `getTopLevelSymbols` (the mandatory CodeIntelligenceAdapter
 *     methods) are delegated to the fallback adapter, because Fullscope is a
 *     higher-layer query surface, not a parser.
 *   - `findReferences` is the only optional method routed through the provider
 *     on this branch. Other optional methods (getDiagnostics, goToDefinition,
 *     callHierarchy) are intentionally absent — they are not part of the
 *     materially shipped Fullscope seam today.
 *   - No new Fullscope-branded adapter methods (`skeleton`, `usages`, etc.) are
 *     added to the contract here. The task scope is the existing
 *     CodeIntelligenceAdapter surface.
 *
 * Empty vs. unavailable semantics (explicit):
 *   - If the provider returns an array, the array is authoritative — even an
 *     empty array means "Fullscope searched and found no cross-file refs".
 *     We never fall back just because the result is empty.
 *   - If the provider returns `undefined`, that is the explicit "not available
 *     for this query" signal; the adapter falls through to the fallback's
 *     `findReferences` when one is implemented.
 *   - If the provider throws an explicit unavailable error posture
 *     (transport fault, MCP timeout, etc.), the adapter falls through to the
 *     fallback. Unexpected provider bugs are rethrown instead of being
 *     silently downgraded into fallback behavior.
 *
 * H13 compliance: the adapter emits no events. Event emission is the engine's
 * responsibility; the adapter is pure logic over the provider + fallback.
 *
 * H2 compliance: no filesystem, git, or MCP transport is touched by this file.
 * All external I/O is behind the injected `FullscopeProvider`.
 */

import type {
  CodeIntelligenceAdapter,
  SyntaxTree,
  Symbol,
  Reference,
} from '../codeIntelligence.js';

// ---------------------------------------------------------------------------
// FullscopeProvider seam — injected by caller; real MCP wiring deferred
// ---------------------------------------------------------------------------

/**
 * A reference entry returned by the Fullscope provider.
 *
 * Shape-compatible with `Reference` so adapter-layer mapping is a direct copy.
 */
export interface FullscopeReference {
  /** Absolute path of the file containing the reference. */
  path: string;
  /** Byte range of the reference site. */
  byteRange: [number, number];
}

/**
 * Injected seam between this adapter and a Fullscope/tpf-mcp backend.
 *
 * Real implementations spawn `node .../tpf-mcp/index.js` and drive its
 * JSON-RPC surface; the real wiring lives in a separate plugin package, not in
 * core Hoplon. Tests use `createMockFullscopeProvider` from
 * `mockFullscopeProvider.ts`.
 *
 * Return contract:
 *   - `undefined` signals "Fullscope cannot answer this query" — the adapter
 *     falls through to `fallbackAdapter.findReferences` when one exists.
 *   - An array (including `[]`) is authoritative — the adapter returns it as
 *     the final answer and does not fall through.
 *   - Only explicit provider-unavailable errors fall through. Unexpected
 *     provider errors are rethrown.
 */
export interface FullscopeProvider {
  /**
   * Find cross-file references to a named symbol.
   *
   * @param file - Absolute path of the file where the symbol is declared, or
   *   the empty string when the declaring file is not known (mirrors the LSP
   *   seam convention; real implementations resolve via their own index).
   * @param symbol - The symbol name to search for.
   * @returns Authoritative reference list, or `undefined` to signal that the
   *   provider cannot service this query.
   */
  findReferences(
    file: string,
    symbol: string,
  ): Promise<FullscopeReference[] | undefined>;
}

export class FullscopeProviderUnavailableError extends Error {
  readonly code = 'provider_unavailable';

  constructor(message = 'fullscope provider unavailable') {
    super(message);
    this.name = 'FullscopeProviderUnavailableError';
  }
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface FullscopeCodeIntelligenceOptions {
  /**
   * Injected Fullscope provider seam. The real MCP transport wiring lives in
   * a separate plugin package; tests pass `createMockFullscopeProvider`.
   */
  provider: FullscopeProvider;

  /**
   * Fallback CodeIntelligenceAdapter (typically tree-sitter).
   *
   * - `parse()` and `getTopLevelSymbols()` are always delegated here (the
   *   Fullscope provider does not replicate these mandatory contract methods).
   * - For `findReferences`, the fallback is consulted when the provider
   *   returns `undefined` or throws an explicit unavailable error. An
   *   authoritative empty array from the provider is NOT a fallback trigger,
   *   and unexpected provider bugs are rethrown.
   *
   * If no fallback is provided, `parse` and `getTopLevelSymbols` throw. In
   * production a tree-sitter fallback is always expected.
   */
  fallbackAdapter?: CodeIntelligenceAdapter;
}

function isFullscopeProviderUnavailable(error: unknown): boolean {
  if (error instanceof FullscopeProviderUnavailableError) {
    return true;
  }
  if (typeof error !== 'object' || error === null) {
    return false;
  }

  const maybeCode =
    'code' in error && typeof error.code === 'string' ? error.code : undefined;
  const maybeName =
    'name' in error && typeof error.name === 'string' ? error.name : undefined;

  return (
    maybeCode === 'provider_unavailable' ||
    maybeName === 'FullscopeProviderUnavailableError'
  );
}

// ---------------------------------------------------------------------------
// Sentinel IDs for adapter-layer errors
// ---------------------------------------------------------------------------

const SENTINEL_ENGINE_ID = 'adapter';
const SENTINEL_CORR_ID = 'adapter-fullscope';

// ---------------------------------------------------------------------------
// createFullscopeCodeIntelligence — synchronous factory
// ---------------------------------------------------------------------------

/**
 * Create a `CodeIntelligenceAdapter` backed by an injected Fullscope provider.
 *
 * Host-opt-in: the engine factory never binds this by default. The shipped
 * default remains local tree-sitter; hosts that already run Fullscope/tpf-mcp
 * and want audit-bound reads through the engine seam can opt in explicitly.
 *
 * @example
 * ```ts
 * import { createFullscopeCodeIntelligence } from './fullscope.js';
 * import { createMockFullscopeProvider } from './mockFullscopeProvider.js';
 *
 * const adapter = createFullscopeCodeIntelligence({
 *   provider: createMockFullscopeProvider({ references: { foo: [...] } }),
 *   fallbackAdapter: treeSitterAdapter,
 * });
 * ```
 */
export function createFullscopeCodeIntelligence(
  options: FullscopeCodeIntelligenceOptions,
): CodeIntelligenceAdapter {
  const { provider, fallbackAdapter } = options;

  async function parse(
    file: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<SyntaxTree> {
    if (!fallbackAdapter) {
      throw new Error(
        `[${SENTINEL_ENGINE_ID}:${SENTINEL_CORR_ID}] createFullscopeCodeIntelligence: ` +
          `parse() requires a fallbackAdapter (no fallback provided). ` +
          `Supply a tree-sitter adapter via the fallbackAdapter option.`,
      );
    }
    return fallbackAdapter.parse(file, content, signal);
  }

  function getTopLevelSymbols(tree: SyntaxTree): Symbol[] {
    if (!fallbackAdapter) {
      throw new Error(
        `[${SENTINEL_ENGINE_ID}:${SENTINEL_CORR_ID}] createFullscopeCodeIntelligence: ` +
          `getTopLevelSymbols() requires a fallbackAdapter (no fallback provided). ` +
          `Supply a tree-sitter adapter via the fallbackAdapter option.`,
      );
    }
    return fallbackAdapter.getTopLevelSymbols(tree);
  }

  async function findReferences(symbol: Symbol): Promise<Reference[]> {
    // Provider is consulted first. Empty array is authoritative; only
    // `undefined` or an explicit unavailable error triggers fallback.
    let providerResult: FullscopeReference[] | undefined;
    try {
      providerResult = await provider.findReferences('', symbol.name);
    } catch (error) {
      if (!isFullscopeProviderUnavailable(error)) {
        throw error;
      }
      providerResult = undefined;
    }

    if (providerResult !== undefined) {
      return providerResult.map((r) => ({ path: r.path, byteRange: r.byteRange }));
    }

    if (fallbackAdapter?.findReferences) {
      return fallbackAdapter.findReferences(symbol);
    }
    return [];
  }

  return {
    parse,
    getTopLevelSymbols,
    findReferences,
  };
}
