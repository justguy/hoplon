/**
 * contracts/structuralTemplate.ts — StructuralTemplate and
 * ExtractStructuralTemplateRequest Zod schemas + inferred types.
 *
 * LC4 — Phase 2 Stage C additive slice.
 *
 * StructuralTemplate is the per-file structural skeleton returned by
 * engine.extractStructuralTemplate(). It replaces full-file context with a
 * compact, deterministic structural skeleton for Stage 2 LLM context injection
 * (recs §15.4 — "Structural Template Injection").
 *
 * ## SymbolKind vocabulary
 *   Aligned with tree-sitter node kinds emitted by the standard queries:
 *   - 'function'   — function_declaration
 *   - 'class'      — class_declaration
 *   - 'interface'  — interface_declaration (TypeScript)
 *   - 'type'       — type_alias_declaration (TypeScript)
 *   - 'variable'   — variable_declaration / lexical_declaration
 *   - 'enum'       — enum_declaration (TypeScript)
 *   - 'unknown'    — anything else captured by the catch-all query pattern
 *
 * ## Determinism (H7)
 *   Files in the result are sorted alphabetically (ascending path).
 *   Within each file, exports / imports / types preserve source order
 *   (byteRange[0] ascending — same order they appear in the source).
 *
 * ## snapshotRef vs snapshotRefId naming
 *   The returned StructuralTemplate carries `snapshotRef: string | null`
 *   (null when the caller did not provide a snapshotRefId, meaning the
 *   template was built from the live filesystem).
 */

import { z } from 'zod';
import { TreeSitterQuerySchema } from './queryStructure.js';

// ---------------------------------------------------------------------------
// SymbolKind
// ---------------------------------------------------------------------------

export const SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'variable',
  'enum',
  'unknown',
] as const;

export const SymbolKindSchema = z.enum(SYMBOL_KINDS);
export type SymbolKind = z.infer<typeof SymbolKindSchema>;

// ---------------------------------------------------------------------------
// ExportEntry
// ---------------------------------------------------------------------------

export const ExportEntrySchema = z.object({
  /** Export name (identifier text). */
  name: z.string().min(1),
  /** Coarse-grained kind inferred from tree-sitter node type. */
  kind: SymbolKindSchema,
  /** Full declaration text (signature line). H13: stored in DTO, not emitted in events. */
  signature: z.string(),
});

export type ExportEntry = z.infer<typeof ExportEntrySchema>;

// ---------------------------------------------------------------------------
// ImportEntry
// ---------------------------------------------------------------------------

export const ImportEntrySchema = z.object({
  /** Module specifier string literal text (e.g. './foo.js', 'zod'). */
  source: z.string().min(1),
  /**
   * Named imports from this source.
   * May be empty for side-effect imports (`import './polyfill.js'`)
   * or when only a default/namespace import is present.
   */
  symbols: z.array(z.string()),
});

export type ImportEntry = z.infer<typeof ImportEntrySchema>;

// ---------------------------------------------------------------------------
// TypeEntry
// ---------------------------------------------------------------------------

export const TypeEntrySchema = z.object({
  /** Type alias / interface name. */
  name: z.string().min(1),
  /** Full declaration text. H13: stored in DTO, not emitted in events. */
  declaration: z.string(),
});

export type TypeEntry = z.infer<typeof TypeEntrySchema>;

// ---------------------------------------------------------------------------
// StructuralTemplateFile — per-file entry in the template
// ---------------------------------------------------------------------------

export const StructuralTemplateFileSchema = z.object({
  /** File path, relative to the fs adapter root. */
  path: z.string().min(1),
  /** Named exports extracted from this file (source order). */
  exports: z.array(ExportEntrySchema),
  /** Import declarations extracted from this file (source order). */
  imports: z.array(ImportEntrySchema),
  /**
   * Top-level type / interface declarations (TypeScript).
   * Empty for JavaScript files or when no type declarations are present.
   */
  types: z.array(TypeEntrySchema),
});

export type StructuralTemplateFile = z.infer<typeof StructuralTemplateFileSchema>;

// ---------------------------------------------------------------------------
// StructuralTemplate — the top-level result
// ---------------------------------------------------------------------------

export const StructuralTemplateSchema = z.object({
  /**
   * Per-file structural skeletons.
   * Sorted by path ascending (H7 determinism).
   */
  files: z.array(StructuralTemplateFileSchema),
  /**
   * Identifies the query bundle that produced this template.
   * Always 'structural-template' for the LC4 built-in bundle.
   * Callers that supply custom queries via the request will see their
   * custom queryId reflected here if provided.
   */
  queryId: z.string().min(1),
  /**
   * The snapshotRefId that this template was extracted from.
   * null when the template was built from the live filesystem (no snapshot provided).
   */
  snapshotRef: z.string().nullable(),
});

export type StructuralTemplate = z.infer<typeof StructuralTemplateSchema>;

// ---------------------------------------------------------------------------
// ExtractStructuralTemplateRequest
// ---------------------------------------------------------------------------

export const ExtractStructuralTemplateRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /**
   * Files to extract from, relative to the fs adapter root.
   * At least one file required.
   * Results are returned in sorted file order (H7 determinism).
   */
  files: z.array(z.string().min(1)).min(1, 'files must not be empty'),
  /**
   * Optional snapshot reference ID.
   * When present: content is read from the git object store at the snapshot's
   * gitRef (no filesystem reads — same readBlob path as dryRun).
   * When absent: content is read from the live filesystem.
   */
  snapshotRefId: z.string().min(1).optional(),
  /**
   * Optional custom query bundle ID to embed in the result.
   * When absent, defaults to 'structural-template'.
   */
  queryId: z.string().min(1).optional(),
  /**
   * Optional custom queries. When provided, replaces the built-in
   * extract-exports + extract-imports + extract-types bundle.
   * Advanced callers use this to compose additional queries.
   */
  customQueries: z.array(TreeSitterQuerySchema).optional(),
});

export type ExtractStructuralTemplateRequest = z.infer<
  typeof ExtractStructuralTemplateRequestSchema
>;
