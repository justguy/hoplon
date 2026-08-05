/** contracts/guardedPlanningRouter.ts - T-158 router proof DTOs.
 *
 * Contract-only boundary for orchestrator-owned guarded planning calls. This
 * module validates identity linkage between a planning request, guardrail
 * bundle, planning-turn evidence, and telemetry proof pointers. It does not
 * route model calls, host NeMo, or create deterministic PASS/BLOCK authority.
 */

import { z } from 'zod';
import {
  PlanningGuardrailBundleSchema,
  PlanningGuardrailEvidenceAuthoritySchema,
} from './planningGuardrailBundle.js';
import { PlanningTurnEvidenceSchema } from './planningTurnEvidence.js';

const HashSchema = z.string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'hash must be sha256:<64-hex>');
const NonEmptyStringSchema = z.string().min(1);

export const GUARDED_PLANNING_ROUTER_SCHEMA_VERSIONS = [
  'hoplon.guarded-planning-router/v1',
] as const;
export const GuardedPlanningRouterSchemaVersionSchema = z.enum(
  GUARDED_PLANNING_ROUTER_SCHEMA_VERSIONS,
);
export type GuardedPlanningRouterSchemaVersion = z.infer<
  typeof GuardedPlanningRouterSchemaVersionSchema
>;

export const GUARDED_PLANNING_POINTER_REF_KINDS = [
  'prompt',
  'model_request',
  'model_response',
  'session',
  'telemetry',
] as const;
export const GuardedPlanningPointerRefKindSchema = z.enum(
  GUARDED_PLANNING_POINTER_REF_KINDS,
);
export const GuardedPlanningPointerRefSchema = z.object({
  refKind: GuardedPlanningPointerRefKindSchema,
  ref: NonEmptyStringSchema,
  refHash: HashSchema.optional(),
}).strict();
export type GuardedPlanningPointerRef = z.infer<
  typeof GuardedPlanningPointerRefSchema
>;

const GuardedPlanningIdentityFieldsSchema = z.object({
  schemaVersion: GuardedPlanningRouterSchemaVersionSchema,
  routerId: NonEmptyStringSchema,
  guardedModelId: NonEmptyStringSchema,
  contractHash: HashSchema,
  guardrailBundleHash: HashSchema,
  plannerTurnId: NonEmptyStringSchema,
  railRuntimeId: NonEmptyStringSchema,
  evidenceAuthority: PlanningGuardrailEvidenceAuthoritySchema,
}).strict();

export const GuardedPlanningModelRequestSchema = GuardedPlanningIdentityFieldsSchema
  .extend({
    planningGuardrailBundle: PlanningGuardrailBundleSchema,
    requestRef: GuardedPlanningPointerRefSchema.optional(),
    sessionRef: GuardedPlanningPointerRefSchema.optional(),
  }).strict().superRefine((request, ctx) => {
    if (request.contractHash !== request.planningGuardrailBundle.contractHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contractHash mismatch between request and planningGuardrailBundle',
        path: ['contractHash'],
      });
    }
    if (request.guardrailBundleHash !== request.planningGuardrailBundle.bundleHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'guardrailBundleHash mismatch between request and bundleHash',
        path: ['guardrailBundleHash'],
      });
    }
    if (request.railRuntimeId !== request.planningGuardrailBundle.targetRuntime.runtimeId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'railRuntimeId mismatch between request and bundle targetRuntime',
        path: ['railRuntimeId'],
      });
    }
  });
export type GuardedPlanningModelRequest = z.infer<
  typeof GuardedPlanningModelRequestSchema
>;

export const GuardedPlanningModelResultSchema = GuardedPlanningIdentityFieldsSchema
  .extend({
    planningTurnEvidence: PlanningTurnEvidenceSchema,
    outputRef: GuardedPlanningPointerRefSchema.optional(),
    telemetryRef: GuardedPlanningPointerRefSchema.optional(),
  }).strict().superRefine((result, ctx) => {
    if (result.contractHash !== result.planningTurnEvidence.contractHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'contractHash mismatch between result and planningTurnEvidence',
        path: ['planningTurnEvidence', 'contractHash'],
      });
    }
    if (result.guardrailBundleHash !== result.planningTurnEvidence.guardrailBundleHash) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'guardrailBundleHash mismatch between result and planningTurnEvidence',
        path: ['planningTurnEvidence', 'guardrailBundleHash'],
      });
    }
    if (result.plannerTurnId !== result.planningTurnEvidence.plannerTurnId) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'plannerTurnId mismatch between result and planningTurnEvidence',
        path: ['planningTurnEvidence', 'plannerTurnId'],
      });
    }
  });
export type GuardedPlanningModelResult = z.infer<
  typeof GuardedPlanningModelResultSchema
>;

export const GuardedPlanningRouterProofSchema = z.object({
  schemaVersion: GuardedPlanningRouterSchemaVersionSchema,
  request: GuardedPlanningModelRequestSchema,
  result: GuardedPlanningModelResultSchema,
  staticImportProofRef: GuardedPlanningPointerRefSchema.optional(),
  runtimeTelemetryProofRef: GuardedPlanningPointerRefSchema.optional(),
  evidenceAuthority: PlanningGuardrailEvidenceAuthoritySchema,
}).strict().superRefine((proof, ctx) => {
  for (const key of ['routerId', 'guardedModelId', 'contractHash',
    'guardrailBundleHash', 'plannerTurnId', 'railRuntimeId'] as const) {
    if (proof.request[key] !== proof.result[key]) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${key} mismatch between guarded planning request and result`,
        path: ['result', key],
      });
    }
  }
});
export type GuardedPlanningRouterProof = z.infer<
  typeof GuardedPlanningRouterProofSchema
>;

export const GUARDED_PLANNING_ROUTER_DIAGNOSTIC_KINDS = [
  'request_invalid',
  'bundle_invalid',
  'hash_mismatch',
  'missing_runtime_identity',
  'evidence_invalid',
  'router_proof_invalid',
] as const;
export const GuardedPlanningRouterDiagnosticKindSchema = z.enum(
  GUARDED_PLANNING_ROUTER_DIAGNOSTIC_KINDS,
);
export type GuardedPlanningRouterDiagnosticKind = z.infer<
  typeof GuardedPlanningRouterDiagnosticKindSchema
>;

export const GuardedPlanningRouterDiagnosticSchema = z.object({
  kind: GuardedPlanningRouterDiagnosticKindSchema,
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).optional(),
}).strict();
export type GuardedPlanningRouterDiagnostic = z.infer<
  typeof GuardedPlanningRouterDiagnosticSchema
>;

export type ParsedGuardedPlanningRouterProof =
  | { ok: true; proof: GuardedPlanningRouterProof }
  | { ok: false; diagnostics: GuardedPlanningRouterDiagnostic[] };

export function parseGuardedPlanningRouterProof(
  input: unknown,
): ParsedGuardedPlanningRouterProof {
  const parsed = GuardedPlanningRouterProofSchema.safeParse(input);
  if (parsed.success) return { ok: true, proof: parsed.data };
  return {
    ok: false,
    diagnostics: parsed.error.issues.map(issueToDiagnostic),
  };
}

function issueToDiagnostic(issue: z.ZodIssue): GuardedPlanningRouterDiagnostic {
  const path = [...issue.path];
  const message = issue.message;
  if (path.includes('railRuntimeId')) {
    return { kind: 'missing_runtime_identity', message, path };
  }
  if (message.includes('mismatch')) {
    return { kind: 'hash_mismatch', message, path };
  }
  if (path[0] === 'request' && path.includes('planningGuardrailBundle')) {
    return { kind: 'bundle_invalid', message, path };
  }
  if (path[0] === 'result' && path.includes('planningTurnEvidence')) {
    return { kind: 'evidence_invalid', message, path };
  }
  if (path[0] === 'request') return { kind: 'request_invalid', message, path };
  return { kind: 'router_proof_invalid', message, path };
}
