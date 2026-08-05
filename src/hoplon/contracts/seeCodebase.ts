/**
 * contracts/seeCodebase.ts — SeeCodebaseRequest / SeeCodebaseEnvelope
 * Zod schemas and inferred types for the t-061 unified agent-facing
 * read/search macro.
 *
 * t-061 ships one Hoplon-owned surface that reuses the already-shipped
 * structural primitives (`packContext`, `extractStructuralTemplate`,
 * `queryStructure`, `searchSymbols`, `describeProject`) and adds the
 * missing raw file read + raw text search coverage so callers do not have
 * to fall back to host `cat` / `rg` on supported work.
 *
 * Why this envelope exists:
 *   - The t-060 contract defined the shape; t-061 ships runtime for it.
 *   - `mode: skeleton` is additive vs. t-060's `auto|structural|raw` and
 *     reuses `extractStructuralTemplate`/`query skeleton` — it is NOT a
 *     new compression engine.
 *   - Auto routing uses request intent PLUS file-kind support, never an
 *     extension-only heuristic.
 *   - The response envelope is load-bearing: callers (and the `t-064`
 *     benchmark harness) rely on `provenance.selectedPath`,
 *     `routingReason`, `primitivesUsed`, fallback flags, and metrics to
 *     bucket runs without re-deriving routing from logs.
 *   - `strict: true` blocks silent fallback between structural / skeleton
 *     / raw — the error envelope reports which path was requested and
 *     which would have been used.
 *
 * The envelope is an `ok: true | false` discriminated union so MCP / CLI
 * / HTTP callers see a structured block rather than a thrown exception
 * when the macro cannot serve the request under the caller's constraints.
 */

import { z } from 'zod';
import { StrictEngagementContextSchema } from './engagementContext.js';
import { AdvisoryIntelligenceSidecarEnvelopeSchema } from './advisoryIntelligence.js';
import {
  SeeCodebasePrimitiveIdSchema,
  SeeCodebaseResultSchema,
} from './seeCodebaseResults.js';
import { SeeCodebaseTargetSchema } from './seeCodebaseTargets.js';
import { TokenTelemetrySchema } from './tokenTelemetry.js';
export {
  SeeCodebaseAstNodeIdentitySchema,
  SeeCodebasePrimitiveIdSchema,
  SeeCodebaseReadProvenanceSchema,
  SeeCodebaseResultSchema,
} from './seeCodebaseResults.js';
export type {
  SeeCodebaseAstNodeIdentity,
  SeeCodebasePrimitiveId,
  SeeCodebaseReadProvenance,
  SeeCodebaseResult,
} from './seeCodebaseResults.js';
export {
  SeeCodebaseAstNodeExpectedIdentitySchema,
  SeeCodebaseAstNodeSelectorSchema,
  SeeCodebaseTargetSchema,
} from './seeCodebaseTargets.js';
export type {
  SeeCodebaseAstNodeExpectedIdentity,
  SeeCodebaseAstNodeSelector,
  SeeCodebaseTarget,
} from './seeCodebaseTargets.js';

// ---------------------------------------------------------------------------
// Intent (routing driver #1)
// ---------------------------------------------------------------------------

export const SEE_CODEBASE_INTENTS = [
  'understand_code_shape',
  'find_symbol',
  'read_exact_text',
  'search_exact_text',
  'inspect_docs_or_config',
  'inspect_logs_or_env',
  'orient_project',
  'mixed',
] as const;

export const SeeCodebaseIntentSchema = z.enum(SEE_CODEBASE_INTENTS);
export type SeeCodebaseIntent = z.infer<typeof SeeCodebaseIntentSchema>;

// ---------------------------------------------------------------------------
// Mode (routing driver #2) — `skeleton` is additive vs. t-060
// ---------------------------------------------------------------------------

export const SEE_CODEBASE_MODES = ['auto', 'structural', 'raw', 'skeleton'] as const;
export const SeeCodebaseModeSchema = z.enum(SEE_CODEBASE_MODES);
export type SeeCodebaseMode = z.infer<typeof SeeCodebaseModeSchema>;

export const SeeCodebaseSemanticSearchOptionsSchema = z.object({
  enabled: z.boolean().optional().default(true),
  topK: z.number().int().positive().optional(),
  sessionId: z.string().min(1).optional(),
  freshness: z.enum(['indexed', 'live_session']).optional(),
  allowDegraded: z.boolean().optional(),
  allowStale: z.boolean().optional(),
  resultFields: z.enum(['path_only', 'path_and_symbol', 'snippet']).optional(),
});
export type SeeCodebaseSemanticSearchOptions = z.infer<
  typeof SeeCodebaseSemanticSearchOptionsSchema
>;

export const SeeCodebaseAdvisoryIntelligenceOptionsSchema = z.object({
  /**
   * Caller-selected semantic-search bound. Omitted means seeCodebase may still
   * report structural metadata and semantic provider status, but it will not
   * issue vector search with a hidden default top-K.
   */
  semanticTopK: z.number().int().positive().optional(),
  semanticSearch: SeeCodebaseSemanticSearchOptionsSchema.optional(),
});
export type SeeCodebaseAdvisoryIntelligenceOptions = z.infer<
  typeof SeeCodebaseAdvisoryIntelligenceOptionsSchema
>;

// ---------------------------------------------------------------------------
// Request
// ---------------------------------------------------------------------------

export const SeeCodebaseRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),

  intent: SeeCodebaseIntentSchema,
  targets: z.array(SeeCodebaseTargetSchema).min(1, 'at least one target is required'),

  mode: SeeCodebaseModeSchema.optional().default('auto'),
  strict: z.boolean().optional().default(false),
  includeProvenance: z.boolean().optional().default(true),
  advisoryIntelligence: SeeCodebaseAdvisoryIntelligenceOptionsSchema.optional(),
  /**
   * Optional outside the compatibility profile. Required by strict-agent
   * transport wrappers before read/search dispatch.
   */
  engagement: StrictEngagementContextSchema.optional(),

  /**
   * Optional explicit byte cap on the response. When set and honored the
   * envelope reports `truncated: true` with `truncationReason: 'maxBytes'`.
   * There is no silent default truncation under this contract.
   */
  maxBytes: z.number().int().positive().optional(),

  /**
   * Optional cap on raw-search matches. When set and the match list hits
   * the cap the envelope reports `truncated: true` with
   * `truncationReason: 'maxResults'`.
   */
  maxResults: z.number().int().positive().optional(),
}).superRefine((value, ctx) => {
  value.targets.forEach((target, index) => {
    if (target.kind !== 'edit_slice') return;
    if (target.endLine < target.startLine) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['targets', index, 'endLine'],
        message: 'endLine must be greater than or equal to startLine',
      });
    }
  });
});

export type SeeCodebaseRequest = z.input<typeof SeeCodebaseRequestSchema>;
export type SeeCodebaseRequestValidated = z.output<typeof SeeCodebaseRequestSchema>;

// ---------------------------------------------------------------------------
// Selected path + file-kind support enums (envelope reporting)
// ---------------------------------------------------------------------------

export const SeeCodebaseSelectedPathSchema = z.enum([
  'structural',
  'skeleton',
  'raw',
  'structural+raw',
  'skeleton+raw',
]);
export type SeeCodebaseSelectedPath = z.infer<typeof SeeCodebaseSelectedPathSchema>;

export const SeeCodebaseFileKindSupportSchema = z.enum([
  'js_ts',
  'other_supported',
  'unsupported',
  'mixed',
  'not_applicable',
]);
export type SeeCodebaseFileKindSupport = z.infer<typeof SeeCodebaseFileKindSupportSchema>;

// ---------------------------------------------------------------------------
// Provenance — load-bearing audit / benchmark envelope
// ---------------------------------------------------------------------------

export const SeeCodebaseProvenanceSchema = z.object({
  selectedPath: SeeCodebaseSelectedPathSchema,
  routingReason: z.string().min(1),
  routingFactors: z.object({
    intent: SeeCodebaseIntentSchema,
    fileKindSupport: SeeCodebaseFileKindSupportSchema,
    modeRequested: SeeCodebaseModeSchema,
    strict: z.boolean(),
  }),
  primitivesUsed: z.array(SeeCodebasePrimitiveIdSchema),
  fallbackOccurred: z.boolean(),
  fallbackBlockedByStrict: z.boolean(),
  truncated: z.boolean(),
  truncationReason: z.string().optional(),
  metrics: z.object({
    latencyMs: z.number().int().nonnegative(),
    bytesReturned: z.number().int().nonnegative(),
    tokensReturned: z.number().int().nonnegative().optional(),
    tokenTelemetry: TokenTelemetrySchema.optional(),
  }),
  correlationId: z.string().min(1),
  engineId: z.string().min(1),
});
export type SeeCodebaseProvenance = z.infer<typeof SeeCodebaseProvenanceSchema>;

// ---------------------------------------------------------------------------
// Error envelope
// ---------------------------------------------------------------------------

export const SEE_CODEBASE_ERROR_KINDS = [
  'STRICT_BLOCKED_FALLBACK',
  'UNSUPPORTED_TARGET',
  'PATH_NOT_FOUND',
  'INVALID_REQUEST',
  'DUPLICATE_TARGET',
  'AMBIGUOUS_TARGET',
  'UNRESOLVED_TARGET',
  'STALE_TARGET',
  'OUT_OF_SCOPE_TARGET',
  'INTERNAL',
] as const;

export const SeeCodebaseErrorKindSchema = z.enum(SEE_CODEBASE_ERROR_KINDS);
export type SeeCodebaseErrorKind = z.infer<typeof SeeCodebaseErrorKindSchema>;

const SeeCodebasePathLabelSchema = z.enum(['structural', 'skeleton', 'raw']);

export const SeeCodebaseErrorSchema = z.object({
  kind: SeeCodebaseErrorKindSchema,
  message: z.string(),
  requestedPath: SeeCodebasePathLabelSchema,
  targetPath: z.string().min(1).optional(),
  suggestedPath: SeeCodebasePathLabelSchema.optional(),
});
export type SeeCodebaseError = z.infer<typeof SeeCodebaseErrorSchema>;

// ---------------------------------------------------------------------------
// Envelope — discriminated union on `ok`
// ---------------------------------------------------------------------------

const OkEnvelopeSchema = z.object({
  ok: z.literal(true),
  data: z.object({
    results: z.array(SeeCodebaseResultSchema),
    partial: z.literal(true).optional(),
    errors: z.array(SeeCodebaseErrorSchema).optional(),
  }),
  provenance: SeeCodebaseProvenanceSchema.optional(),
  intelligence: z.array(AdvisoryIntelligenceSidecarEnvelopeSchema).optional(),
});

const ErrEnvelopeSchema = z.object({
  ok: z.literal(false),
  error: SeeCodebaseErrorSchema,
  provenance: SeeCodebaseProvenanceSchema.optional(),
});

export const SeeCodebaseEnvelopeSchema = z.discriminatedUnion('ok', [
  OkEnvelopeSchema,
  ErrEnvelopeSchema,
]);
export type SeeCodebaseEnvelope = z.infer<typeof SeeCodebaseEnvelopeSchema>;
