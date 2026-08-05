/**
 * contracts/planningGuardrailClauses.ts — FencedContract clause taxonomy (T-155).
 *
 * The clause discriminated union covers the six families a FencedContract
 * carries: goals, boundaries, allowed/prohibited domains, allowed/prohibited
 * tool intents, success criteria, and evidence requirements.
 *
 * Each clause has a stable, author-provided `clauseId` so downstream
 * artifacts (planning guardrail bundle, deterministic policy bundle, audit
 * evidence, Control Room review) can reference it by identity rather than
 * by index or by paraphrase.
 *
 * Imported by `planningGuardrails.ts`. This module owns no identity, hash,
 * or validation logic — only schemas.
 */

import { z } from 'zod';

const ClauseIdSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,
  'clauseId must match /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/',
);
const DescriptionSchema = z.string().min(1).max(1024);

export const FencedContractGoalClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('goal'),
  description: DescriptionSchema,
  goalKind: z.enum(['primary', 'secondary']),
}).strict();

export const FencedContractBoundaryClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('boundary'),
  description: DescriptionSchema,
  boundaryKind: z.enum(['paths', 'branches', 'symbols']),
  values: z.array(z.string().min(1)).min(1),
}).strict();

export const FencedContractDomainAllowlistClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('domain_allowlist'),
  description: DescriptionSchema,
  domains: z.array(z.string().min(1)).min(1),
}).strict();

export const FencedContractDomainDenylistClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('domain_denylist'),
  description: DescriptionSchema,
  domains: z.array(z.string().min(1)).min(1),
}).strict();

export const FencedContractToolIntentAllowlistClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('tool_intent_allowlist'),
  description: DescriptionSchema,
  toolIntents: z.array(z.string().min(1)).min(1),
}).strict();

export const FencedContractToolIntentDenylistClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('tool_intent_denylist'),
  description: DescriptionSchema,
  toolIntents: z.array(z.string().min(1)).min(1),
}).strict();

export const FencedContractSuccessCriterionClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('success_criterion'),
  description: DescriptionSchema,
  criterionKind: z.enum(['test_passes', 'state_predicate', 'human_signoff']),
  expression: z.string().min(1).optional(),
}).strict();

export const FencedContractEvidenceRequirementClauseSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: z.literal('evidence_requirement'),
  description: DescriptionSchema,
  evidenceKind: z.enum([
    'audit_log',
    'snapshot_diff',
    'human_review',
    'planning_turn',
    'verification_run',
  ]),
  mandatory: z.boolean(),
}).strict();

export const FencedContractClauseSchema = z.discriminatedUnion('clauseType', [
  FencedContractGoalClauseSchema,
  FencedContractBoundaryClauseSchema,
  FencedContractDomainAllowlistClauseSchema,
  FencedContractDomainDenylistClauseSchema,
  FencedContractToolIntentAllowlistClauseSchema,
  FencedContractToolIntentDenylistClauseSchema,
  FencedContractSuccessCriterionClauseSchema,
  FencedContractEvidenceRequirementClauseSchema,
]);
export type FencedContractClause = z.infer<typeof FencedContractClauseSchema>;
export type FencedContractClauseType = FencedContractClause['clauseType'];
