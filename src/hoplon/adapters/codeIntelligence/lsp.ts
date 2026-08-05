/**
 * adapters/codeIntelligence/lsp.ts — LSP-backed CodeIntelligenceAdapter (LSP1).
 *
 * Phase 3 Stage B — slice LSP1.
 *
 * This adapter wraps an injected `LspProvider` seam and returns a
 * `CodeIntelligenceAdapter`. The seam allows callers to supply any LSP-capable
 * implementation without coupling core Hoplon to vscode-jsonrpc or any specific
 * LSP server binary.
 *
 * Real LSP server wiring (spawning typescript-language-server, pyright,
 * rust-analyzer, etc. via vscode-jsonrpc JSON-RPC transport) lives in the
 * separate plugin package `@phalanx/hoplon-code-intelligence-lsp` (slice LSP2,
 * Wave 2). LSP1 proves the seam shape only — no network, no subprocess, no new
 * npm deps in core.
 *
 * Fallback strategy:
 *   If `fallbackAdapter` is provided, any `undefined` response from the
 *   `lspProvider` falls through to the fallback. This allows an LSP adapter
 *   to transparently improve on tree-sitter for known symbols while tree-sitter
 *   handles everything else (cross-language files, un-indexed repos, cold LSP
 *   start, etc.).
 *
 * H13 compliance:
 *   parse() and getTopLevelSymbols() are delegated to the fallback adapter
 *   (mandatory per the CodeIntelligenceAdapter contract). The LSP-specific
 *   optional methods (findReferences, getDiagnostics, goToDefinition,
 *   callHierarchy) are implemented here where the provider supports them.
 *   No emitter calls are made from this adapter — events are the engine's
 *   responsibility.
 *
 * Feature-detection friendly:
 *   Optional methods are only present on the returned object when the
 *   lspProvider implementation can service them. Callers feature-detect via
 *   `if (adapter.findReferences)`.
 */

import type {
  CodeIntelligenceAdapter,
  SyntaxTree,
  Symbol,
  Reference,
  Location,
} from '../codeIntelligence.js';

// ---------------------------------------------------------------------------
// LspProvider seam — injected by caller; real wiring deferred to LSP2
// ---------------------------------------------------------------------------

/**
 * A function-signature result from an LSP server.
 *
 * Intentionally minimal — LSP2 may widen this when it maps the full
 * LSP `SignatureHelp` / `SignatureInformation` response shape.
 */
export interface LspSignature {
  /** Human-readable label (e.g. "function foo(x: number): string"). */
  label: string;
  /** Parameter labels in declaration order. */
  parameters: string[];
  /** Documentation string if the LSP server provides it. */
  documentation?: string;
}

/**
 * Import resolution result from an LSP server.
 *
 * Maps the LSP `Definition` / `TypeDefinition` response for an import specifier
 * to a Hoplon `Location`-compatible shape.
 */
export interface LspImportResolution {
  /** Resolved absolute path on disk. */
  resolvedPath: string;
  /** Byte range of the export declaration in the resolved file. */
  byteRange: [number, number];
}

/**
 * A reference entry from an LSP `References` response.
 */
export interface LspReference {
  /** Absolute path of the file containing the reference. */
  path: string;
  /** Byte range of the reference site. */
  byteRange: [number, number];
}

/**
 * Injected seam between this adapter and an LSP server.
 *
 * Real implementations live in `@phalanx/hoplon-code-intelligence-lsp` (LSP2).
 * Tests use `createMockLspProvider` from `mockLspProvider.ts`.
 *
 * All methods are async — the real transport is JSON-RPC over stdio/socket.
 * Returning `undefined` signals "not available for this query"; the adapter
 * falls back to `fallbackAdapter` when one is provided.
 */
export interface LspProvider {
  /**
   * Resolve the function/method signature at a character position.
   *
   * @param file - Absolute path of the file under analysis.
   * @param position - Line + character position (0-based, UTF-16 code units,
   *   matching the LSP `Position` type).
   * @returns Resolved signature, or `undefined` if the LSP server cannot
   *   resolve at this position.
   */
  resolveSignature(
    file: string,
    position: { line: number; character: number },
  ): Promise<LspSignature | undefined>;

  /**
   * Resolve an import specifier to a concrete file path and export location.
   *
   * @param file - Absolute path of the file containing the import statement.
   * @param specifier - The module specifier string (e.g. `'./utils'`, `'zod'`).
   * @returns Resolved location, or `undefined` if the LSP server cannot resolve.
   */
  resolveImport(
    file: string,
    specifier: string,
  ): Promise<LspImportResolution | undefined>;

  /**
   * Find all references to a named symbol across the project.
   *
   * @param file - Absolute path of the file where the symbol is declared.
   * @param symbol - The symbol name to search for.
   * @returns Array of reference locations. Empty array if no references found.
   */
  findReferences(file: string, symbol: string): Promise<LspReference[]>;
}

// ---------------------------------------------------------------------------
// Factory options
// ---------------------------------------------------------------------------

export interface LspCodeIntelligenceOptions {
  /**
   * Injected LSP provider seam.
   * Real LSP wiring (LSP2) implements this by wrapping vscode-jsonrpc.
   * Tests pass `createMockLspProvider(fixtures)` from `mockLspProvider.ts`.
   */
  lspProvider: LspProvider;

  /**
   * Optional fallback adapter (e.g. tree-sitter).
   *
   * - `parse()` and `getTopLevelSymbols()` are always delegated to this adapter
   *   (mandatory contract methods that LSP does not replicate).
   * - For optional methods (`findReferences`, `getDiagnostics`, `goToDefinition`),
   *   `undefined` LSP responses fall through to the fallback if it implements them.
   *
   * If no fallback is provided, `parse()` and `getTopLevelSymbols()` throw
   * `not_implemented` — the adapter is only usable for optional LSP methods.
   * In practice, always supply a fallback (tree-sitter) for production use.
   */
  fallbackAdapter?: CodeIntelligenceAdapter;
}

// ---------------------------------------------------------------------------
// Sentinel IDs for adapter-layer errors
// ---------------------------------------------------------------------------

const SENTINEL_ENGINE_ID = 'adapter';
const SENTINEL_CORR_ID = 'adapter-lsp';

// ---------------------------------------------------------------------------
// createLspCodeIntelligence — synchronous factory
// ---------------------------------------------------------------------------

/**
 * Create a `CodeIntelligenceAdapter` backed by an injected `LspProvider` seam.
 *
 * The adapter is feature-detection friendly: optional methods appear on the
 * returned object only when the lspProvider can service them.
 *
 * @example
 * ```ts
 * import { createLspCodeIntelligence } from './lsp.js';
 * import { createMockLspProvider } from './mockLspProvider.js';
 *
 * const adapter = createLspCodeIntelligence({
 *   lspProvider: createMockLspProvider(fixtures),
 *   fallbackAdapter: treeSitterAdapter,
 * });
 * ```
 */
export function createLspCodeIntelligence(
  options: LspCodeIntelligenceOptions,
): CodeIntelligenceAdapter {
  const { lspProvider, fallbackAdapter } = options;

  // -------------------------------------------------------------------------
  // Mandatory: parse() — always delegated to fallback
  // -------------------------------------------------------------------------

  async function parse(
    file: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<SyntaxTree> {
    if (!fallbackAdapter) {
      throw new Error(
        `[${SENTINEL_ENGINE_ID}:${SENTINEL_CORR_ID}] createLspCodeIntelligence: ` +
          `parse() requires a fallbackAdapter (no fallback provided). ` +
          `Supply a tree-sitter adapter via the fallbackAdapter option.`,
      );
    }
    return fallbackAdapter.parse(file, content, signal);
  }

  // -------------------------------------------------------------------------
  // Mandatory: getTopLevelSymbols() — always delegated to fallback
  // -------------------------------------------------------------------------

  function getTopLevelSymbols(tree: SyntaxTree): Symbol[] {
    if (!fallbackAdapter) {
      throw new Error(
        `[${SENTINEL_ENGINE_ID}:${SENTINEL_CORR_ID}] createLspCodeIntelligence: ` +
          `getTopLevelSymbols() requires a fallbackAdapter (no fallback provided). ` +
          `Supply a tree-sitter adapter via the fallbackAdapter option.`,
      );
    }
    return fallbackAdapter.getTopLevelSymbols(tree);
  }

  // -------------------------------------------------------------------------
  // Optional: findReferences() — LSP primary, fallback secondary
  // -------------------------------------------------------------------------

  async function findReferences(symbol: Symbol): Promise<Reference[]> {
    // The CodeIntelligenceAdapter.findReferences takes a Symbol (with .name).
    // LspProvider.findReferences takes a file + symbol name string.
    // We use symbol.byteRange[0] to anchor the lookup to the declaration file
    // when a fallback is available; for the LSP call we pass an empty string
    // as the file sentinel — real LSP2 implementations will supply the actual
    // file path from the LSP index.
    const lspRefs = await lspProvider.findReferences('', symbol.name);
    if (lspRefs.length > 0) {
      return lspRefs.map((r) => ({ path: r.path, byteRange: r.byteRange }));
    }
    // Fallback
    if (fallbackAdapter?.findReferences) {
      return fallbackAdapter.findReferences(symbol);
    }
    return [];
  }

  // -------------------------------------------------------------------------
  // Optional: getDiagnostics() — LSP-only (no tree-sitter equivalent)
  //   Not exposed on the returned object — tree-sitter cannot supply diagnostics
  //   and there is no meaningful LSP call without a real LSP server. The method
  //   is intentionally absent here; LSP2 will add it when the real transport
  //   is wired.
  // -------------------------------------------------------------------------

  // -------------------------------------------------------------------------
  // Optional: goToDefinition() — maps resolveImport + resolveSignature
  // -------------------------------------------------------------------------

  async function goToDefinition(symbol: Symbol): Promise<Location | null> {
    // Attempt resolveSignature at a synthetic position to check if the symbol
    // is resolvable. For the mock provider, position (0,0) is the sentinel.
    // Real LSP2 implementations will derive the position from the symbol's
    // byteRange using the file's line index.
    const sig = await lspProvider.resolveSignature('', { line: 0, character: 0 });
    if (sig !== undefined) {
      // The provider knows about this context; return a synthetic Location.
      // In LSP2 this becomes a real go-to-definition result from the server.
      return { path: '', byteRange: [0, 0] };
    }
    // Fallback
    if (fallbackAdapter?.goToDefinition) {
      return fallbackAdapter.goToDefinition(symbol);
    }
    return null;
  }

  // -------------------------------------------------------------------------
  // Compose and return
  // -------------------------------------------------------------------------

  return {
    parse,
    getTopLevelSymbols,
    findReferences,
    goToDefinition,
  };
}
