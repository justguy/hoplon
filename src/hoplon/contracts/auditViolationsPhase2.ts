/**
 * auditViolationsPhase2.ts — Phase 2 additive AuditViolation variant schemas.
 *
 * These schemas extend the AuditViolation discriminated union additively.
 * Phase 1's four canonical kinds (out_of_scope_symbol, uncontracted_file,
 * parse_failure, snapshot_missing) live in audit.ts and are never renamed.
 *
 * All Phase 2 variants share the same invariants as Phase 1:
 *   - mandatory `path` (string, min 1)
 *   - mandatory `message` (context — single sentence)
 *   - mandatory `correction` (mechanical directive — single sentence)
 *   - variant-specific evidence fields
 *
 * Produced by:
 *   - SCOPE_ESCAPE, STRUCTURAL_CORRUPTION, PATH_ESCAPE — auditDiff extensions (Phase 3)
 *   - SIGNATURE_MISMATCH, SIGNATURE_UNCERTAIN       — LC3 checkSignatures
 *   - TARGET_NOT_FOUND, DUPLICATE_TARGET            — LC1 checkTargets
 *   - IMPORT_TARGET_NOT_FOUND, IMPORT_SYMBOL_NOT_EXPORTED,
 *     IMPORT_ALIAS_UNRESOLVED                       — LC2 validateImports
 */

import { z } from 'zod';
import { ManifestScopeSchema } from './manifest.js';

// ---------------------------------------------------------------------------
// Structural / scope kinds
// ---------------------------------------------------------------------------

/**
 * SCOPE_ESCAPE — agent modified a node in its contracted scope but the
 * change affected an out-of-scope parent (e.g. added an export to a class
 * that wasn't in the contract).
 */
export const AuditViolationScopeEscapeSchema = z.object({
  kind: z.literal('SCOPE_ESCAPE'),
  path: z.string().min(1),
  /** The node kind that escapes (e.g. 'export_statement'). */
  escapingNodeKind: z.string().min(1),
  /** The parent it attaches to. */
  parentNodeKind: z.string().min(1),
  /** UTF-8 byte offsets [start, end) of the escaping node (H20). */
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  sourceSlice: z.string(),
  truncated: z.boolean().optional(),
  /** The contracted scope that the escape violated. */
  expectedScope: ManifestScopeSchema,
  message: z.string().min(1),
  correction: z.string().min(1),
});

/**
 * STRUCTURAL_CORRUPTION — edit broke a parent scope's structural integrity.
 * The tree-sitter parse succeeded overall, but a specific structural unit
 * is malformed (e.g. unclosed brace, missing semicolon in a statement list).
 */
export const AuditViolationStructuralCorruptionSchema = z.object({
  kind: z.literal('STRUCTURAL_CORRUPTION'),
  path: z.string().min(1),
  /** The tree-sitter ERROR or missing node kind. */
  corruptedNodeKind: z.string().min(1),
  /** UTF-8 byte offsets [start, end) of the corrupted node (H20). */
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  sourceSlice: z.string(),
  truncated: z.boolean().optional(),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/**
 * PATH_ESCAPE — path traversal detected at audit time. Defense-in-depth
 * (H9 already catches at engine boundary, but a defense-in-depth audit-time
 * check is valid).
 */
export const AuditViolationPathEscapeSchema = z.object({
  kind: z.literal('PATH_ESCAPE'),
  /** The attempted path that escaped. */
  path: z.string().min(1),
  /** What the path resolved to. */
  resolvedPath: z.string().min(1),
  sandboxRoot: z.string().min(1),
  message: z.string().min(1),
  correction: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Signature kinds — produced by LC3 checkSignatures
// ---------------------------------------------------------------------------

/**
 * SIGNATURE_MISMATCH — declared signature contract violated; clear evidence.
 */
export const AuditViolationSignatureMismatchSchema = z.object({
  kind: z.literal('SIGNATURE_MISMATCH'),
  path: z.string().min(1),
  /** The function/method name. */
  symbol: z.string().min(1),
  /** Stringified expected signature. */
  expected: z.string().min(1),
  /** Stringified actual signature. */
  actual: z.string().min(1),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/**
 * SIGNATURE_UNCERTAIN — generic/overload comparison ambiguous; NOT a hard
 * block (Phase 2 limitation — defer to ts-morph in Phase 3).
 */
export const AuditViolationSignatureUncertainSchema = z.object({
  kind: z.literal('SIGNATURE_UNCERTAIN'),
  path: z.string().min(1),
  symbol: z.string().min(1),
  /** Explains why the comparison is uncertain. */
  note: z.string().min(1),
  message: z.string().min(1),
  correction: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Target-existence kinds — produced by LC1 checkTargets
// ---------------------------------------------------------------------------

/**
 * TARGET_NOT_FOUND — manifest entry with intent:'modify' references a
 * symbol that doesn't exist in the snapshot (phantom target).
 */
export const AuditViolationTargetNotFoundSchema = z.object({
  kind: z.literal('TARGET_NOT_FOUND'),
  path: z.string().min(1),
  symbolName: z.string().min(1),
  manifestIntent: z.literal('modify'),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/**
 * DUPLICATE_TARGET — manifest entry with intent:'create' references a
 * symbol that already exists in the snapshot.
 */
export const AuditViolationDuplicateTargetSchema = z.object({
  kind: z.literal('DUPLICATE_TARGET'),
  path: z.string().min(1),
  symbolName: z.string().min(1),
  manifestIntent: z.literal('create'),
  /** Where the existing symbol is (UTF-8 byte offsets). */
  existingByteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  message: z.string().min(1),
  correction: z.string().min(1),
});

// ---------------------------------------------------------------------------
// Import kinds — produced by LC2 validateImports
// ---------------------------------------------------------------------------

/**
 * IMPORT_TARGET_NOT_FOUND — imported file doesn't exist in snapshot.
 */
export const AuditViolationImportTargetNotFoundSchema = z.object({
  kind: z.literal('IMPORT_TARGET_NOT_FOUND'),
  /** The file doing the import. */
  path: z.string().min(1),
  /** The path it tried to import. */
  importPath: z.string().min(1),
  /** Same as path, for consistency with recs. */
  fromFile: z.string().min(1),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/**
 * IMPORT_SYMBOL_NOT_EXPORTED — imported file exists but doesn't export
 * the requested symbol.
 */
export const AuditViolationImportSymbolNotExportedSchema = z.object({
  kind: z.literal('IMPORT_SYMBOL_NOT_EXPORTED'),
  path: z.string().min(1),
  importPath: z.string().min(1),
  symbol: z.string().min(1),
  /** What the file does export. */
  availableExports: z.array(z.string()),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/**
 * IMPORT_ALIAS_UNRESOLVED — tsconfig path alias not resolved (Phase 2
 * scope limitation; Phase 3 enhancement).
 */
export const AuditViolationImportAliasUnresolvedSchema = z.object({
  kind: z.literal('IMPORT_ALIAS_UNRESOLVED'),
  path: z.string().min(1),
  importPath: z.string().min(1),
  /** E.g. "Path alias resolution requires tsconfig — deferred to Phase 3". */
  note: z.string().min(1),
  message: z.string().min(1),
  correction: z.string().min(1),
});
