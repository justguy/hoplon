/**
 * gc.ts — transport contract for snapshot garbage collection.
 *
 * The engine exposes `gc` on the public surface, and both the shipped HTTP
 * transport and the PG1 proto registry need the same request/response DTOs.
 * Keeping them here avoids transport-local duplicates.
 */

import { z } from 'zod';

export const GcRequestSchema = z.object({
  projectId: z.string().optional(),
  olderThan: z.string().optional(),
  expiredBefore: z.string().optional(),
  semanticCache: z.boolean().optional(),
  semanticOverlays: z.boolean().optional(),
  semanticTombstones: z.boolean().optional(),
});

export type GcRequest = z.infer<typeof GcRequestSchema>;

export const GcResultSchema = z.object({
  deletedCount: z.number().int().nonnegative(),
  semanticCacheEntriesDeleted: z.number().int().nonnegative().optional(),
  semanticOverlaysReaped: z.number().int().nonnegative().optional(),
  semanticTombstonesDeleted: z.number().int().nonnegative().optional(),
  degradationReasons: z.array(z.string().min(1)).optional(),
});

export type GcResult = z.infer<typeof GcResultSchema>;
