/**
 * adapters/codeIntelligence.ts — CodeIntelligenceAdapter interface.
 *
 * Phase 1 default: createTreeSitterIntelligence({ grammarsDir }) —
 *   implements parse() and getTopLevelSymbols() using web-tree-sitter (WASM).
 * Phase 2+ swap target: LSP client wrapping typescript-language-server,
 *   pyright, rust-analyzer, etc.
 *
 * Placeholder types are minimal and opaque enough that tree-sitter can satisfy
 * them without leaking its native type. The D3 tree-sitter slice will refine them.
 *
 * The parse/getTopLevelSymbols pair is mandatory; the LSP-specific methods
 * (findReferences, getDiagnostics, goToDefinition, callHierarchy) are optional
 * to allow Phase 1 adapters to implement only what is needed.
 */

// ---------------------------------------------------------------------------
// Placeholder types (Phase 1 — D3 tree-sitter slice will refine)
// ---------------------------------------------------------------------------

/**
 * Opaque representation of a parsed syntax tree.
 * Kept intentionally minimal so tree-sitter's native SyntaxNode doesn't leak
 * into the contract boundary. Phase 2+ LSP adapters can widen as needed.
 */
export interface SyntaxTree {
  rootNode: { kind: string; children: unknown[] };
}

/** A named symbol in a file (function, class, variable, etc.). */
export interface Symbol {
  name: string;
  kind: string;
  byteRange: [number, number];
}

/** A reference to a symbol at a specific location. */
export interface Reference {
  path: string;
  byteRange: [number, number];
}

/** A diagnostic message (error, warning, info) from the code intelligence backend. */
export interface Diagnostic {
  path: string;
  message: string;
  severity: 'error' | 'warning' | 'info';
  byteRange: [number, number];
}

/** A location in a file (used by goToDefinition). */
export interface Location {
  path: string;
  byteRange: [number, number];
}

/** Call hierarchy node (used by callHierarchy). */
export interface CallHierarchy {
  symbol: Symbol;
  callers: Symbol[];
  callees: Symbol[];
}

// ---------------------------------------------------------------------------
// CodeIntelligenceAdapter interface
// ---------------------------------------------------------------------------

export interface CodeIntelligenceAdapter {
  // -------------------------------------------------------------------------
  // Mandatory (Phase 1 tree-sitter implementation supplies these)
  // -------------------------------------------------------------------------

  /**
   * Parse a file's content into a syntax tree.
   * Respects the AbortSignal for tree-sitter timeout (H12, H15).
   */
  parse(file: string, content: Uint8Array, signal?: AbortSignal): Promise<SyntaxTree>;

  /** Extract top-level symbols from a parsed syntax tree. */
  getTopLevelSymbols(tree: SyntaxTree): Symbol[];

  // -------------------------------------------------------------------------
  // Optional (Phase 2+ LSP implementations supply these)
  // -------------------------------------------------------------------------

  /** Find all references to a symbol across the project. */
  findReferences?(symbol: Symbol): Promise<Reference[]>;

  /**
   * Return the direct dependencies for a file from an optional Layer 2 index.
   *
   * This remains an additive cross-file seam. The shipped tree-sitter default
   * does not implement it; hosts that bind LSP/SCIP-style providers opt into
   * the method explicitly.
   */
  findDependencies?(file: string): Promise<string[]>;

  /** Get diagnostics (errors, warnings) for a file. */
  getDiagnostics?(file: string): Promise<Diagnostic[]>;

  /** Go to the definition of a symbol. Returns null if not found. */
  goToDefinition?(symbol: Symbol): Promise<Location | null>;

  /** Return the call hierarchy (callers + callees) for a symbol. */
  callHierarchy?(symbol: Symbol): Promise<CallHierarchy>;
}
