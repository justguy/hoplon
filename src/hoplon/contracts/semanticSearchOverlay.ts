import { z } from 'zod';

import { StrictEngagementContextSchema } from './engagementContext.js';
import { SemanticCorpusDocumentSchema } from './semanticSearchCorpus.js';
import {
  SemanticDegradationReasonSchema,
  SemanticSearchStatusSchema,
} from './semanticSearchStatus.js';

export const SemanticOverlayModeSchema = z.enum(['dry_run', 'written_bytes']);
export type SemanticOverlayMode = z.infer<typeof SemanticOverlayModeSchema>;

export const SemanticOverlayInputSourceSchema = z.enum([
  'proposed_changes',
  'written_bytes',
  'live_files',
  'failure_mask',
]);
export type SemanticOverlayInputSource = z.infer<
  typeof SemanticOverlayInputSourceSchema
>;

export const SemanticOverlayRefreshRequestSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  /**
   * Optional outside the compatibility profile; inert there. Required by
   * strict-agent transport wrappers (together with `engagement`) before
   * semantic dispatch — see transport/strictEngagementCheck.ts.
   */
  runId: z.string().min(1).optional(),
  engagement: StrictEngagementContextSchema.optional(),
  sessionId: z.string().min(1),
  worktreeId: z.string().min(1).optional(),
  mode: SemanticOverlayModeSchema,
  inputSource: SemanticOverlayInputSourceSchema,
  touchedFiles: z.array(z.string().min(1)),
  documents: z.array(SemanticCorpusDocumentSchema).optional(),
  status: SemanticSearchStatusSchema.optional(),
  degradationReasons: z.array(SemanticDegradationReasonSchema).optional(),
  aborted: z.boolean().optional(),
});
export type SemanticOverlayRefreshRequest = z.infer<
  typeof SemanticOverlayRefreshRequestSchema
>;

export const SemanticOverlayRefreshResultSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  status: SemanticSearchStatusSchema,
  mode: SemanticOverlayModeSchema,
  inputSource: SemanticOverlayInputSourceSchema,
  overlayGeneration: z.number().int().nonnegative(),
  published: z.boolean(),
  retainedPreviousOverlay: z.boolean(),
  touchedFileCount: z.number().int().nonnegative(),
  documentCount: z.number().int().nonnegative(),
  lexicalCount: z.number().int().nonnegative(),
  vectorCount: z.number().int().nonnegative(),
  maskCount: z.number().int().nonnegative(),
  degradationReasons: z.array(SemanticDegradationReasonSchema),
});
export type SemanticOverlayRefreshResult = z.infer<
  typeof SemanticOverlayRefreshResultSchema
>;

export const SemanticOverlayClearRequestSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  /**
   * Optional outside the compatibility profile; inert there. Required by
   * strict-agent transport wrappers (together with `engagement`) before
   * semantic dispatch — see transport/strictEngagementCheck.ts.
   */
  runId: z.string().min(1).optional(),
  engagement: StrictEngagementContextSchema.optional(),
  worktreeId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
});
export type SemanticOverlayClearRequest = z.infer<
  typeof SemanticOverlayClearRequestSchema
>;

export const SemanticOverlayClearResultSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1),
  worktreeId: z.string().min(1).optional(),
  sessionId: z.string().min(1),
  cleared: z.boolean(),
});
export type SemanticOverlayClearResult = z.infer<
  typeof SemanticOverlayClearResultSchema
>;
