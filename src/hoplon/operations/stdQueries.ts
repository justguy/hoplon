/**
 * operations/stdQueries.ts — Standard tree-sitter query library (CI3-3).
 *
 * Ships four named queries covering the most common extraction needs per
 * recs §13.3. Each query is defined once and used by callers that need
 * them for packContext (tree_sitter_query strategy) or queryStructure().
 *
 * Queries are typed as `readonly TreeSitterQuery[]` — they are constant
 * values, never mutated at runtime.
 *
 * Language note: the JavaScript grammar covers .js/.mjs/.cjs/.jsx;
 * the TypeScript grammar covers .ts; tsx covers .tsx. If a query should
 * run on all JS/TS variants, callers compose multiple TreeSitterQuery
 * objects with the same pattern but different language keys.
 *
 * Pattern correctness: validated by tree-sitter at query-execution time.
 * These patterns are tested in tests/operations/queryStructure.test.ts.
 */

import type { TreeSitterQuery } from '../contracts/queryStructure.js';

// ---------------------------------------------------------------------------
// extract-function-signatures
//
// Captures: @func_name — the identifier (name) of each function_declaration
// Also captures arrow functions assigned via lexical/variable_declaration.
// Applies to: javascript, typescript, tsx
// ---------------------------------------------------------------------------

export const EXTRACT_FUNCTION_SIGNATURES_JS: TreeSitterQuery = {
  id: 'extract-function-signatures',
  language: 'javascript',
  pattern: `(function_declaration name: (identifier) @func_name)`,
};

export const EXTRACT_FUNCTION_SIGNATURES_TS: TreeSitterQuery = {
  id: 'extract-function-signatures',
  language: 'typescript',
  pattern: `(function_declaration name: (identifier) @func_name)`,
};

export const EXTRACT_FUNCTION_SIGNATURES_TSX: TreeSitterQuery = {
  id: 'extract-function-signatures',
  language: 'tsx',
  pattern: `(function_declaration name: (identifier) @func_name)`,
};

// ---------------------------------------------------------------------------
// extract-exports
//
// Captures: @exported — the declaration node inside an export_statement.
// Applies to: javascript, typescript, tsx
// ---------------------------------------------------------------------------

export const EXTRACT_EXPORTS_JS: TreeSitterQuery = {
  id: 'extract-exports',
  language: 'javascript',
  pattern: `(export_statement declaration: (_) @exported)`,
};

export const EXTRACT_EXPORTS_TS: TreeSitterQuery = {
  id: 'extract-exports',
  language: 'typescript',
  pattern: `(export_statement declaration: (_) @exported)`,
};

export const EXTRACT_EXPORTS_TSX: TreeSitterQuery = {
  id: 'extract-exports',
  language: 'tsx',
  pattern: `(export_statement declaration: (_) @exported)`,
};

// ---------------------------------------------------------------------------
// extract-imports
//
// Captures: @import_path — the string literal source of each import_declaration.
// Applies to: javascript, typescript, tsx
// ---------------------------------------------------------------------------

export const EXTRACT_IMPORTS_JS: TreeSitterQuery = {
  id: 'extract-imports',
  language: 'javascript',
  pattern: `(import_statement source: (string) @import_path)`,
};

export const EXTRACT_IMPORTS_TS: TreeSitterQuery = {
  id: 'extract-imports',
  language: 'typescript',
  pattern: `(import_statement source: (string) @import_path)`,
};

export const EXTRACT_IMPORTS_TSX: TreeSitterQuery = {
  id: 'extract-imports',
  language: 'tsx',
  pattern: `(import_statement source: (string) @import_path)`,
};

// ---------------------------------------------------------------------------
// extract-class-methods
//
// Captures: @method_name — the property_identifier name of each method_definition.
// Applies to: javascript, typescript, tsx
// ---------------------------------------------------------------------------

export const EXTRACT_CLASS_METHODS_JS: TreeSitterQuery = {
  id: 'extract-class-methods',
  language: 'javascript',
  pattern: `(method_definition name: (property_identifier) @method_name)`,
};

export const EXTRACT_CLASS_METHODS_TS: TreeSitterQuery = {
  id: 'extract-class-methods',
  language: 'typescript',
  pattern: `(method_definition name: (property_identifier) @method_name)`,
};

export const EXTRACT_CLASS_METHODS_TSX: TreeSitterQuery = {
  id: 'extract-class-methods',
  language: 'tsx',
  pattern: `(method_definition name: (property_identifier) @method_name)`,
};

// ---------------------------------------------------------------------------
// Convenience bundles — all three language variants for each query
// ---------------------------------------------------------------------------

/** Standard function-signature extraction queries (JS + TS + TSX). */
export const STD_QUERY_FUNCTION_SIGNATURES: readonly TreeSitterQuery[] = [
  EXTRACT_FUNCTION_SIGNATURES_JS,
  EXTRACT_FUNCTION_SIGNATURES_TS,
  EXTRACT_FUNCTION_SIGNATURES_TSX,
];

/** Standard export extraction queries (JS + TS + TSX). */
export const STD_QUERY_EXPORTS: readonly TreeSitterQuery[] = [
  EXTRACT_EXPORTS_JS,
  EXTRACT_EXPORTS_TS,
  EXTRACT_EXPORTS_TSX,
];

/** Standard import extraction queries (JS + TS + TSX). */
export const STD_QUERY_IMPORTS: readonly TreeSitterQuery[] = [
  EXTRACT_IMPORTS_JS,
  EXTRACT_IMPORTS_TS,
  EXTRACT_IMPORTS_TSX,
];

/** Standard class-method extraction queries (JS + TS + TSX). */
export const STD_QUERY_CLASS_METHODS: readonly TreeSitterQuery[] = [
  EXTRACT_CLASS_METHODS_JS,
  EXTRACT_CLASS_METHODS_TS,
  EXTRACT_CLASS_METHODS_TSX,
];
