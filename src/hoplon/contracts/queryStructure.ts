/**
 * queryStructure.ts — TreeSitterQuery, QueryMatch, QueryStructureRequest,
 * QueryStructureResult Zod schemas and inferred types.
 *
 * CI3-3 — Phase 2 Stage C additive slice.
 *
 * TreeSitterQuery is the S-expression query descriptor used by both the
 * new ASTStrategy variant (`kind: 'tree_sitter_query'`) and directly by
 * the engine.queryStructure() method.
 *
 * Design notes:
 *  - id    — caller-assigned stable identifier (e.g. 'extract-function-signatures').
 *            Used for correlation in results; not validated against a registry.
 *  - language — language grammar key. Validated against the supported set from
 *               treeSitter.ts: javascript | typescript | tsx.
 *               Unsupported language → ValidationError({ kind: 'invalid_query' }).
 *  - pattern  — S-expression string. Validated by tree-sitter's own Query
 *               constructor at runtime; invalid syntax → ValidationError.
 *
 * QueryMatch is the per-capture result. Each capture name from the query
 * produces its own QueryMatch record. Multiple captures in one pattern
 * produce multiple records per file. Results are emitted in sorted file
 * order (per H7 determinism mandate for queryStructure).
 *
 * QueryMatchGroup is the additive grouped result. It preserves tree-sitter
 * Query.matches() grouping without removing the flat matches[] compatibility
 * surface.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// TreeSitterQuery
// ---------------------------------------------------------------------------

export const SUPPORTED_QUERY_LANGUAGES = ['javascript', 'typescript', 'tsx'] as const;
export type QueryLanguage = (typeof SUPPORTED_QUERY_LANGUAGES)[number];

export const TreeSitterQuerySchema = z.object({
  /** Caller-assigned stable identifier. */
  id: z.string().min(1, 'query id must be non-empty'),
  /** Language grammar key — must match a supported tree-sitter grammar. */
  language: z.enum(SUPPORTED_QUERY_LANGUAGES),
  /** S-expression query pattern — validated by tree-sitter at execution time. */
  pattern: z.string().min(1, 'query pattern must be non-empty'),
});

export type TreeSitterQuery = z.infer<typeof TreeSitterQuerySchema>;

// ---------------------------------------------------------------------------
// QueryMatch — one capture result from one file
// ---------------------------------------------------------------------------

export const QueryMatchSchema = z.object({
  /** Echoes the TreeSitterQuery.id that produced this match. */
  queryId: z.string().min(1),
  /** File path, relative to the fs adapter root. */
  path: z.string().min(1),
  /** Capture name from the S-expression (e.g. '@name', '@func_name'). */
  captureName: z.string().min(1),
  /** Verbatim source text of the captured node. */
  text: z.string(),
  /**
   * UTF-8 byte range [start, end) of this capture in the file.
   * H20 invariant: values are UTF-8 byte offsets produced via charPosToBytePos.
   */
  byteRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  /** tree-sitter node kind (e.g. 'identifier', 'function_declaration'). */
  nodeKind: z.string().min(1),
  /** Stable grouped-match identifier when this flat capture came from a group. */
  matchId: z.string().min(1).optional(),
  /** Zero-based tree-sitter query pattern index. */
  patternIndex: z.number().int().nonnegative().optional(),
  /** Zero-based capture index within the grouped match. */
  captureIndex: z.number().int().nonnegative().optional(),
  /** Grammar field name for the captured node when directly available. */
  fieldName: z.string().min(1).optional(),
  /** Grammar field ancestry from root toward the captured node, when available. */
  fieldPath: z.array(z.string().min(1)).optional(),
});

export type QueryMatch = z.infer<typeof QueryMatchSchema>;

// ---------------------------------------------------------------------------
// QueryMatchGroup — one tree-sitter Query.matches() record
// ---------------------------------------------------------------------------

export const QueryMatchGroupSchema = z.object({
  /** Stable identity for this grouped match within a queryStructure result. */
  matchId: z.string().min(1),
  /** Echoes the TreeSitterQuery.id that produced this group. */
  queryId: z.string().min(1),
  /** File path, relative to the fs adapter root. */
  path: z.string().min(1),
  /** Zero-based tree-sitter query pattern index. */
  patternIndex: z.number().int().nonnegative(),
  /** Captures associated with this tree-sitter grouped match. */
  captures: z.array(QueryMatchSchema),
});

export type QueryMatchGroup = z.infer<typeof QueryMatchGroupSchema>;

// ---------------------------------------------------------------------------
// QueryStructureRequest
// ---------------------------------------------------------------------------

export const QueryStructureRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /**
   * Files to query, relative to the fs adapter root.
   * Results are returned in sorted file order (H7 determinism).
   */
  files: z.array(z.string().min(1)).min(1, 'files must not be empty'),
  /**
   * Queries to execute against each file.
   * At least one query required. A query is skipped for files whose language
   * does not match query.language — no error, no match emitted.
   */
  queries: z.array(TreeSitterQuerySchema).min(1, 'queries must not be empty'),
  /** Optional snapshot reference ID — reserved for future snapshotRef-scoped queries. */
  snapshotRefId: z.string().min(1).optional(),
});

export type QueryStructureRequest = z.infer<typeof QueryStructureRequestSchema>;

// ---------------------------------------------------------------------------
// QueryStructureResult
// ---------------------------------------------------------------------------

export const QueryStructureResultSchema = z.object({
  /**
   * All captures from all queries on all matching files.
   * Sorted by: (path ascending, queryId ascending, byteRange[0] ascending).
   * An empty array means no captures matched — not an error condition.
   */
  matches: z.array(QueryMatchSchema),
  /**
   * Additive grouped Query.matches() output. Flat matches[] remains the
   * compatibility surface for existing callers.
   */
  matchGroups: z.array(QueryMatchGroupSchema).optional(),
  /**
   * Per-file failures (file_not_found, parse_failure, invalid_query per file/query).
   * Always present; may be empty.
   */
  failures: z.array(
    z.object({
      path: z.string().min(1),
      queryId: z.string(),
      reason: z.enum(['file_not_found', 'parse_failure', 'invalid_query', 'unsupported_extension']),
      message: z.string(),
    }),
  ),
});

export type QueryStructureResult = z.infer<typeof QueryStructureResultSchema>;
