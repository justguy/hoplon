/**
 * adapters/codeIntelligence/mockLspProvider.ts — In-memory LspProvider for tests (LSP1).
 *
 * Phase 3 Stage B — slice LSP1.
 *
 * Implements the `LspProvider` seam from `lsp.ts` using fixture data. Constructed
 * with maps of fixtures keyed by symbol name / import specifier; no subprocess,
 * no network, no vscode-jsonrpc dependency.
 *
 * Real LSP server wiring lives in `@phalanx/hoplon-code-intelligence-lsp` (LSP2,
 * Wave 2). This file is the in-process test double used by LSP1 contract tests.
 *
 * Usage:
 * ```ts
 * const provider = createMockLspProvider({
 *   signatures: {
 *     'Array.from': {
 *       label: 'Array.from<T>(arrayLike: ArrayLike<T>): T[]',
 *       parameters: ['arrayLike: ArrayLike<T>'],
 *     },
 *   },
 *   imports: {
 *     './utils': { resolvedPath: '/project/src/utils.ts', byteRange: [0, 100] },
 *   },
 *   references: {
 *     createSnapshot: [
 *       { path: '/project/src/engine.ts', byteRange: [120, 136] },
 *     ],
 *   },
 * });
 * ```
 */

import type { LspProvider, LspSignature, LspImportResolution, LspReference } from './lsp.js';

// ---------------------------------------------------------------------------
// Fixture maps
// ---------------------------------------------------------------------------

/**
 * Fixture data for `resolveSignature`.
 *
 * Keys are symbol names (used as lookup keys by the mock). The real LSP2
 * implementation resolves by (file, position) — the mock simplifies by
 * using position as a key index into `signaturesByPosition` or falling back
 * to the first registered signature for the given file.
 */
export type SignatureFixtures = Record<string, LspSignature>;

/**
 * Fixture data for `resolveImport`.
 *
 * Keys are import specifier strings (e.g. `'./utils'`, `'zod'`).
 */
export type ImportFixtures = Record<string, LspImportResolution>;

/**
 * Fixture data for `findReferences`.
 *
 * Keys are symbol names.
 */
export type ReferenceFixtures = Record<string, LspReference[]>;

// ---------------------------------------------------------------------------
// Position-keyed signatures (optional fine-grained fixture)
// ---------------------------------------------------------------------------

/**
 * Fine-grained fixture keyed by `"file:line:character"`.
 * When present, takes precedence over the name-keyed `SignatureFixtures`.
 */
export type PositionSignatureFixtures = Record<string, LspSignature>;

// ---------------------------------------------------------------------------
// MockLspProviderOptions
// ---------------------------------------------------------------------------

export interface MockLspProviderOptions {
  /**
   * Signatures keyed by symbol name.
   * Returned by `resolveSignature` when the position key does not match
   * `positionSignatures`.
   *
   * The mock provider returns the first signature entry whose key appears
   * as a substring of the resolved position key — or the entry for key `'*'`
   * as a catch-all.
   *
   * Example: key `'Array.from'` matches if the file path contains `'Array.from'`.
   * For testing, supply a `'*'` catch-all to always return a fixed signature.
   */
  signatures?: SignatureFixtures;

  /**
   * Fine-grained signatures keyed by `"file:line:character"`.
   * Takes precedence over `signatures`.
   */
  positionSignatures?: PositionSignatureFixtures;

  /**
   * Import resolutions keyed by specifier string.
   */
  imports?: ImportFixtures;

  /**
   * Reference lists keyed by symbol name.
   */
  references?: ReferenceFixtures;
}

// ---------------------------------------------------------------------------
// createMockLspProvider — factory
// ---------------------------------------------------------------------------

/**
 * Create an in-memory `LspProvider` for tests, backed by fixture maps.
 *
 * All methods return `Promise.resolve(...)` with no async I/O. Thread-safe
 * (no shared mutable state between calls — fixtures are read-only after
 * construction).
 *
 * Returning `undefined` from any method signals "not available" to the
 * `createLspCodeIntelligence` adapter, which then falls through to the
 * fallback adapter. Tests can leverage this to prove fallback behaviour by
 * deliberately omitting fixture entries.
 */
export function createMockLspProvider(options: MockLspProviderOptions = {}): LspProvider {
  const {
    signatures = {},
    positionSignatures = {},
    imports = {},
    references = {},
  } = options;

  // -------------------------------------------------------------------------
  // resolveSignature
  // -------------------------------------------------------------------------

  async function resolveSignature(
    file: string,
    position: { line: number; character: number },
  ): Promise<LspSignature | undefined> {
    // 1. Try fine-grained position key first.
    const posKey = `${file}:${position.line}:${position.character}`;
    if (Object.prototype.hasOwnProperty.call(positionSignatures, posKey)) {
      return positionSignatures[posKey];
    }

    // 2. Try catch-all `'*'` key.
    if (Object.prototype.hasOwnProperty.call(signatures, '*')) {
      return signatures['*'];
    }

    // 3. Try file-name match: return the first entry whose key is a substring
    //    of `file` (allows tests to key by a short filename segment).
    for (const [key, sig] of Object.entries(signatures)) {
      if (file.includes(key)) {
        return sig;
      }
    }

    return undefined;
  }

  // -------------------------------------------------------------------------
  // resolveImport
  // -------------------------------------------------------------------------

  async function resolveImport(
    _file: string,
    specifier: string,
  ): Promise<LspImportResolution | undefined> {
    if (Object.prototype.hasOwnProperty.call(imports, specifier)) {
      return imports[specifier];
    }
    return undefined;
  }

  // -------------------------------------------------------------------------
  // findReferences
  // -------------------------------------------------------------------------

  async function findReferences(
    _file: string,
    symbol: string,
  ): Promise<LspReference[]> {
    if (Object.prototype.hasOwnProperty.call(references, symbol)) {
      return references[symbol]!;
    }
    return [];
  }

  return { resolveSignature, resolveImport, findReferences };
}
