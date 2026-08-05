/**
 * contracts/postEditPolicy.ts - advisory post-edit content policy sidecar.
 *
 * This sidecar is scoped to review/preview packaging. It can surface redacted
 * findings for proposed or applied edit bytes, but it is advisory-only and
 * cannot alter deterministic PASS/BLOCK results.
 */

import { z } from 'zod';
import {
  AdvisoryEvidenceStateSchema,
  AdvisoryIntelligenceProviderStateSchema,
  createAdvisoryIntelligenceAuthority,
  createAdvisoryEvidenceState,
  createStrictAgentIntelligenceAccess,
} from './advisoryIntelligence.js';

export const POST_EDIT_POLICY_FINDING_CATEGORIES = [
  'secret',
  'forbidden_import',
  'high_risk_call',
  'dlp',
  'other',
] as const;
export const PostEditPolicyFindingCategorySchema = z.enum(
  POST_EDIT_POLICY_FINDING_CATEGORIES,
);
export type PostEditPolicyFindingCategory = z.infer<
  typeof PostEditPolicyFindingCategorySchema
>;

export const PostEditPolicyFindingSchema = z.object({
  ruleId: z.string().min(1),
  category: PostEditPolicyFindingCategorySchema,
  path: z.string().min(1),
  lineNumber: z.number().int().positive().nullable(),
  redactedSnippet: z.string(),
  detail: z.string().min(1).nullable(),
});
export type PostEditPolicyFinding = z.infer<
  typeof PostEditPolicyFindingSchema
>;

export const POST_EDIT_POLICY_REASONS = [
  'not_requested',
  'no_scanner',
  'no_changed_files',
  'no_findings',
  'scanner_failed',
] as const;
export const PostEditPolicyReasonSchema = z.enum(POST_EDIT_POLICY_REASONS);
export type PostEditPolicyReason = z.infer<
  typeof PostEditPolicyReasonSchema
>;

export const PostEditPolicyScanSidecarSchema = z.object({
  version: z.literal(1),
  advisory: z.literal(true),
  status: z.enum(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'EMPTY']),
  provider: AdvisoryIntelligenceProviderStateSchema,
  evidence: AdvisoryEvidenceStateSchema,
  reason: PostEditPolicyReasonSchema.nullable(),
  scannedFiles: z.array(z.string().min(1)),
  findings: z.array(PostEditPolicyFindingSchema),
  authority: z.object({
    canMutateFiles: z.literal(false),
    canChangeDeterministicVerdict: z.literal(false),
    deterministicVerdictAuthority: z.literal('structural_manifest_policy_only'),
  }),
  strictAgentAccess: z.object({
    hoplonMediatedPayloadOnly: z.literal(true),
    exposesFullscopeTool: z.literal(false),
    exposesVectorTool: z.literal(false),
    exposesLspTool: z.literal(false),
    exposesFilesystemTool: z.literal(false),
  }),
});
export type PostEditPolicyScanSidecar = z.infer<
  typeof PostEditPolicyScanSidecarSchema
>;

export interface PostEditPolicyScanInput {
  readonly path: string;
  readonly beforeBytes: Uint8Array | null;
  readonly afterBytes: Uint8Array | null;
  readonly phase: 'preview' | 'post-edit';
}

export interface PostEditPolicyScanner {
  readonly providerId: string;
  scan(
    input: PostEditPolicyScanInput,
    signal?: AbortSignal,
  ): Promise<readonly PostEditPolicyFinding[]>;
}

export function createPostEditPolicyUnavailable(
  reason: Exclude<PostEditPolicyReason, 'scanner_failed' | 'no_findings'>,
): PostEditPolicyScanSidecar {
  return PostEditPolicyScanSidecarSchema.parse({
    version: 1,
    advisory: true,
    status: reason === 'no_changed_files' ? 'EMPTY' : 'UNAVAILABLE',
    provider: {
      providerId: 'post_edit_policy',
      status: 'unavailable',
      reason,
      detail: null,
    },
    evidence: createAdvisoryEvidenceState({
      status: reason === 'no_changed_files' ? 'EMPTY' : 'NO_VERDICT',
      reason,
    }),
    reason,
    scannedFiles: [],
    findings: [],
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
  });
}
