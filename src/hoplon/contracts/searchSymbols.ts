/**
 * contracts/searchSymbols.ts — SearchSymbolsRequest / SearchSymbolsResult
 * Zod schemas and inferred types.
 *
 * t-056 — Local AST-aware search slice.
 *
 * SearchSymbols is a read-only structural search over the project's JS/TS
 * source files. It answers code-shape questions ("where is the function
 * `createFoo` declared?") via tree-sitter, NOT generic substring grep over
 * docs, comments, env vars, or arbitrary text.
 *
 * The match `name` field is matched against a caller-supplied regex
 * (anchored at the caller's discretion). Kinds restrict the structural
 * categories searched: function declarations, class declarations, exported
 * declarations, top-level type/interface/enum aliases, and class methods.
 *
 * Determinism (H7): results are sorted by `(path, name, byteRange[0])`.
 * Limits (H15): callers cap result size via `maxResults`; truncation is
 * surfaced explicitly.
 */

import { z } from 'zod';
import { StrictEngagementContextSchema } from './engagementContext.js';

// ---------------------------------------------------------------------------
// SearchableSymbolKind — the structural categories this slice covers.
// Distinct from StructuralTemplate.SymbolKind because search ranges over the
// concrete AST shapes the standard query bundle can extract today; we add
// 'method' which is not a top-level export but is a real declaration.
// ---------------------------------------------------------------------------

export const SEARCHABLE_SYMBOL_KINDS = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'method',
  'export',
] as const;

export const SearchableSymbolKindSchema = z.enum(SEARCHABLE_SYMBOL_KINDS);
export type SearchableSymbolKind = z.infer<typeof SearchableSymbolKindSchema>;

// ---------------------------------------------------------------------------
// SearchSymbolsRequest
// ---------------------------------------------------------------------------

const MAX_RESULTS_HARD_CEILING = 5_000;
const DEFAULT_MAX_RESULTS = 200;

export const SearchSymbolsRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /**
   * Optional outside the compatibility profile. Required by strict-agent
   * transport wrappers before structural search dispatch.
   */
  engagement: StrictEngagementContextSchema.optional(),

  /**
   * Regex applied to each candidate symbol name. The pattern is compiled with
   * the JavaScript RegExp engine; invalid patterns surface as
   * ValidationError({ kind: 'invalid_manifest' }).
   */
  namePattern: z.string().min(1, 'namePattern must be non-empty'),

  /**
   * Optional explicit file list (relative to fs root). When omitted, the
   * operation walks the project tree (skipping node_modules, .git, .hoplon,
   * dist, build) and considers every JS/TS source file.
   */
  files: z.array(z.string().min(1)).optional(),

  /**
   * Restrict the structural categories searched. Default: every kind.
   * 'export' matches any declaration that appears inside an export_statement.
   */
  kinds: z.array(SearchableSymbolKindSchema).optional(),

  /**
   * Result cap. Default 200. Hard ceiling 5000 to keep responses bounded;
   * structural searches that legitimately need more should narrow `files`
   * or tighten `namePattern`.
   */
  maxResults: z
    .number()
    .int()
    .positive()
    .max(MAX_RESULTS_HARD_CEILING)
    .optional()
    .default(DEFAULT_MAX_RESULTS),
});

/**
 * Request type uses `z.input` so callers may omit defaulted fields
 * (`maxResults`). Internal parsing fills the default; downstream code that
 * needs the post-default shape uses `z.output<typeof SearchSymbolsRequestSchema>`.
 */
export type SearchSymbolsRequest = z.input<typeof SearchSymbolsRequestSchema>;

// ---------------------------------------------------------------------------
// SearchSymbolMatch
// ---------------------------------------------------------------------------

export const SearchSymbolMatchSchema = z.object({
  /** File path relative to fs root. */
  path: z.string().min(1),
  /** Captured symbol name. */
  name: z.string().min(1),
  /** Structural category that produced this match. */
  kind: SearchableSymbolKindSchema,
  /** UTF-8 byte range of the captured identifier (H20). */
  byteRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  /** Tree-sitter node kind of the captured identifier (e.g. 'identifier'). */
  nodeKind: z.string().min(1),
});

export type SearchSymbolMatch = z.infer<typeof SearchSymbolMatchSchema>;

// ---------------------------------------------------------------------------
// SearchSymbolsResult
// ---------------------------------------------------------------------------

export const SearchSymbolsResultSchema = z.object({
  /**
   * Sorted matches: `(path, name, byteRange[0])` ascending. Always present;
   * may be empty when no symbol matches the pattern.
   */
  matches: z.array(SearchSymbolMatchSchema),
  /**
   * Per-file query failures (file_not_found, parse_failure, invalid_query,
   * unsupported_extension). Populated by the underlying queryStructure run;
   * failures here do NOT throw — callers inspect this list explicitly.
   */
  failures: z.array(
    z.object({
      path: z.string().min(1),
      reason: z.enum([
        'file_not_found',
        'parse_failure',
        'invalid_query',
        'unsupported_extension',
      ]),
      message: z.string(),
    }),
  ),
  /** Number of files that participated in the search after filtering. */
  filesScanned: z.number().int().nonnegative(),
  /** Whether the matches array was truncated to honor `maxResults`. */
  truncated: z.boolean(),
});

export type SearchSymbolsResult = z.infer<typeof SearchSymbolsResultSchema>;
