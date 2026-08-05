/**
 * astStrategy.ts — ASTStrategy Zod discriminated union and inferred type.
 *
 * Phase 1 ships two strategies: whole_file and symbols.
 * Phase 2 CI3-3 adds: tree_sitter_query (additive — existing variants stay intact).
 * Future Bucket (Phase 2+, additive): focus_with_skeleton.
 * The discriminated union accepts new variants without breaking callers.
 */

import { z } from 'zod';
import { TreeSitterQuerySchema } from './queryStructure.js';

export const ASTStrategyWholeFileSchema = z.object({
  kind: z.literal('whole_file'),
});

export const ASTStrategySymbolsSchema = z.object({
  kind: z.literal('symbols'),
  /** Top-level symbol names to pack. At least one symbol required. */
  symbols: z.array(z.string().min(1)).min(1, 'symbols strategy must name at least one symbol'),
});

/**
 * Phase 2 CI3-3 additive variant — tree-sitter Query DSL.
 *
 * Uses S-expression queries (per §13.3) instead of hand-written traversal.
 * packContext applies each query to each file whose language matches; captures
 * become PackedSlice entries.
 */
export const ASTStrategyTreeSitterQuerySchema = z.object({
  kind: z.literal('tree_sitter_query'),
  /** At least one query required. Queries are applied in array order. */
  queries: z.array(TreeSitterQuerySchema).min(1, 'tree_sitter_query strategy must have at least one query'),
});

export const ASTStrategySchema = z.discriminatedUnion('kind', [
  ASTStrategyWholeFileSchema,
  ASTStrategySymbolsSchema,
  ASTStrategyTreeSitterQuerySchema,
]);

export type ASTStrategy = z.infer<typeof ASTStrategySchema>;
