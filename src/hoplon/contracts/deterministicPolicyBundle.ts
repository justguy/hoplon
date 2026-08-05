/** contracts/deterministicPolicyBundle.ts - T-160 handoff policy DTOs.
 * Pure FencedContract mapper for deterministic handoff preview; no runtime gate.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../util/stableStringify.js';
import {
  parseFencedContract,
  type FencedContractClause,
  type FencedContractDiagnostic,
} from './planningGuardrails.js';

const HashSchema = z.string()
  .regex(/^sha256:[0-9a-f]{64}$/, 'hash must be sha256:<64-hex>');
const ClauseIdSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,
  'clauseId must match /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/',
);
const NonEmptyStringSchema = z.string().min(1);

export const DETERMINISTIC_POLICY_BUNDLE_SCHEMA_VERSIONS = [
  'hoplon.deterministic-policy-bundle/v1',
] as const;
export const DeterministicPolicyBundleSchemaVersionSchema = z.enum(
  DETERMINISTIC_POLICY_BUNDLE_SCHEMA_VERSIONS,
);
export type DeterministicPolicyBundleSchemaVersion = z.infer<
  typeof DeterministicPolicyBundleSchemaVersionSchema
>;
export const DETERMINISTIC_POLICY_AUTHORITY = 'handoff_preview' as const;
export const DeterministicPolicyAuthoritySchema = z.literal(
  DETERMINISTIC_POLICY_AUTHORITY,
);
export type DeterministicPolicyAuthority = z.infer<
  typeof DeterministicPolicyAuthoritySchema
>;
export const DeterministicPolicyKindSchema = z.enum([
  'path_scope',
  'branch_scope',
  'symbol_scope',
  'allow_tool_intent',
  'deny_tool_intent',
  'required_evidence',
]);
export type DeterministicPolicyKind = z.infer<typeof DeterministicPolicyKindSchema>;
export const DeterministicPolicyEntrySchema = z.object({
  policyId: NonEmptyStringSchema,
  clauseId: ClauseIdSchema,
  policyKind: DeterministicPolicyKindSchema,
  values: z.array(NonEmptyStringSchema).min(1),
}).strict();
export type DeterministicPolicyEntry = z.infer<
  typeof DeterministicPolicyEntrySchema
>;
export const AdvisoryClauseMappingSchema = z.object({
  clauseId: ClauseIdSchema,
  clauseType: NonEmptyStringSchema,
  reason: NonEmptyStringSchema,
}).strict();
export type AdvisoryClauseMapping = z.infer<typeof AdvisoryClauseMappingSchema>;

const DeterministicPolicyBundleBodyBaseSchema = z.object({
  schemaVersion: DeterministicPolicyBundleSchemaVersionSchema,
  contractHash: HashSchema,
  compilerId: NonEmptyStringSchema,
  compilerVersion: NonEmptyStringSchema,
  deterministicPolicies: z.array(DeterministicPolicyEntrySchema),
  clauseToPolicyMap: z.array(z.object({
    clauseId: ClauseIdSchema,
    policyIds: z.array(NonEmptyStringSchema).min(1),
  }).strict()),
  advisoryClauseMap: z.array(AdvisoryClauseMappingSchema),
  policyAuthority: DeterministicPolicyAuthoritySchema,
}).strict();
type DeterministicPolicyBundleBodyShape = z.infer<
  typeof DeterministicPolicyBundleBodyBaseSchema
>;

export const DeterministicPolicyBundleBodySchema =
  DeterministicPolicyBundleBodyBaseSchema.superRefine(addDuplicatePolicyIssues);
export type DeterministicPolicyBundleBody = DeterministicPolicyBundleBodyShape;

export const DeterministicPolicyBundleSchema =
  DeterministicPolicyBundleBodyBaseSchema.extend({
    policyBundleHash: HashSchema,
  }).strict().superRefine((bundle, ctx) => {
    addDuplicatePolicyIssues(bundle, ctx);
    const expected = hashCanonicalDeterministicPolicyBundleBody(
      stripPolicyBundleHash(bundle),
    );
    if (bundle.policyBundleHash !== expected) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'supplied policyBundleHash does not match canonical hash of body',
        path: ['policyBundleHash'],
      });
    }
  });
export type DeterministicPolicyBundle = z.infer<
  typeof DeterministicPolicyBundleSchema
>;

export const DETERMINISTIC_POLICY_COMPILER_DIAGNOSTIC_KINDS = [
  'request_invalid',
  'contract_invalid',
  'policy_bundle_invalid',
] as const;
export const DeterministicPolicyCompilerDiagnosticKindSchema = z.enum(
  DETERMINISTIC_POLICY_COMPILER_DIAGNOSTIC_KINDS,
);
export type DeterministicPolicyCompilerDiagnosticKind = z.infer<
  typeof DeterministicPolicyCompilerDiagnosticKindSchema
>;

export const DeterministicPolicyCompilerDiagnosticSchema = z.object({
  kind: DeterministicPolicyCompilerDiagnosticKindSchema,
  message: NonEmptyStringSchema,
  path: z.array(z.union([z.string(), z.number()])).optional(),
  upstreamKind: z.string().optional(),
}).strict();
export type DeterministicPolicyCompilerDiagnostic = z.infer<
  typeof DeterministicPolicyCompilerDiagnosticSchema
>;

export const DeterministicPolicyCompilerRequestSchema = z.object({
  contract: z.unknown(),
  compilerId: NonEmptyStringSchema,
  compilerVersion: NonEmptyStringSchema,
}).strict();
export type DeterministicPolicyCompilerRequest = z.infer<
  typeof DeterministicPolicyCompilerRequestSchema
>;

export type CompiledDeterministicPolicyBundle =
  | { ok: true; bundle: DeterministicPolicyBundle; policyBundleHash: string }
  | { ok: false; diagnostics: DeterministicPolicyCompilerDiagnostic[] };

export function compileFencedContractToDeterministicPolicyBundle(
  input: unknown,
): CompiledDeterministicPolicyBundle {
  const requestParse = DeterministicPolicyCompilerRequestSchema.safeParse(input);
  if (!requestParse.success) {
    return diagnosticsFromZod('request_invalid', requestParse.error.issues);
  }
  const contractParse = parseFencedContract(requestParse.data.contract);
  if (!contractParse.ok) {
    return {
      ok: false,
      diagnostics: contractParse.diagnostics.map(contractDiagnostic),
    };
  }

  const deterministicPolicies = contractParse.contract.clauses
    .flatMap(policyEntriesForClause);
  const clauseToPolicyMap = deterministicPolicies.map((policy) => ({
    clauseId: policy.clauseId,
    policyIds: [policy.policyId],
  }));
  const advisoryClauseMap = contractParse.contract.clauses
    .filter((clause) => policyEntriesForClause(clause).length === 0)
    .map((clause) => advisoryMappingForClause(clause));
  const body = {
    schemaVersion: DETERMINISTIC_POLICY_BUNDLE_SCHEMA_VERSIONS[0],
    contractHash: contractParse.contract.contractHash,
    compilerId: requestParse.data.compilerId,
    compilerVersion: requestParse.data.compilerVersion,
    deterministicPolicies,
    clauseToPolicyMap,
    advisoryClauseMap,
    policyAuthority: DETERMINISTIC_POLICY_AUTHORITY,
  };
  const policyBundleHash = hashDeterministicPolicyBundle(body);
  const bundleParse = DeterministicPolicyBundleSchema.safeParse({
    ...body,
    policyBundleHash,
  });
  if (!bundleParse.success) {
    return diagnosticsFromZod('policy_bundle_invalid', bundleParse.error.issues);
  }
  return { ok: true, bundle: bundleParse.data, policyBundleHash };
}

export function hashDeterministicPolicyBundle(
  body: DeterministicPolicyBundleBody,
): string {
  const normalized = DeterministicPolicyBundleBodySchema.parse(body);
  return hashCanonicalDeterministicPolicyBundleBody(normalized);
}

function hashCanonicalDeterministicPolicyBundleBody(
  body: DeterministicPolicyBundleBodyShape,
): string {
  const digest = createHash('sha256')
    .update(stableStringify(body), 'utf8')
    .digest('hex');
  return `sha256:${digest}`;
}

function policyEntriesForClause(clause: FencedContractClause): DeterministicPolicyEntry[] {
  if (clause.clauseType === 'boundary') {
    const policyKind = clause.boundaryKind === 'paths'
      ? 'path_scope'
      : clause.boundaryKind === 'branches' ? 'branch_scope' : 'symbol_scope';
    return [entry(clause.clauseId, policyKind, clause.values)];
  }
  if (clause.clauseType === 'tool_intent_allowlist') {
    return [entry(clause.clauseId, 'allow_tool_intent', clause.toolIntents)];
  }
  if (clause.clauseType === 'tool_intent_denylist') {
    return [entry(clause.clauseId, 'deny_tool_intent', clause.toolIntents)];
  }
  if (clause.clauseType === 'evidence_requirement'
    && clause.evidenceKind !== 'human_review') {
    return [entry(clause.clauseId, 'required_evidence', [clause.evidenceKind])];
  }
  return [];
}

function entry(
  clauseId: string,
  policyKind: DeterministicPolicyKind,
  values: readonly string[],
): DeterministicPolicyEntry {
  return {
    policyId: `policy.${policyKind}.${clauseId}`,
    clauseId,
    policyKind,
    values: [...values],
  };
}

function advisoryMappingForClause(clause: FencedContractClause): AdvisoryClauseMapping {
  return {
    clauseId: clause.clauseId,
    clauseType: clause.clauseType,
    reason: `${clause.clauseType} is semantic or human-review evidence, not exact execution policy`,
  };
}

function stripPolicyBundleHash(
  bundle: DeterministicPolicyBundle,
): DeterministicPolicyBundleBody {
  return {
    schemaVersion: bundle.schemaVersion,
    contractHash: bundle.contractHash,
    compilerId: bundle.compilerId,
    compilerVersion: bundle.compilerVersion,
    deterministicPolicies: bundle.deterministicPolicies,
    clauseToPolicyMap: bundle.clauseToPolicyMap,
    advisoryClauseMap: bundle.advisoryClauseMap,
    policyAuthority: bundle.policyAuthority,
  };
}

function addDuplicatePolicyIssues(
  body: DeterministicPolicyBundleBodyShape,
  ctx: z.RefinementCtx,
): void {
  const seen = new Set<string>();
  for (const [index, policy] of body.deterministicPolicies.entries()) {
    if (seen.has(policy.policyId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `duplicate policyId: ${policy.policyId}`,
        path: ['deterministicPolicies', index, 'policyId'],
      });
    }
    seen.add(policy.policyId);
  }
}

function contractDiagnostic(
  diagnostic: FencedContractDiagnostic,
): DeterministicPolicyCompilerDiagnostic {
  return {
    kind: 'contract_invalid',
    message: diagnostic.message,
    path: diagnostic.path,
    upstreamKind: diagnostic.kind,
  };
}

function diagnosticsFromZod(
  kind: DeterministicPolicyCompilerDiagnostic['kind'],
  issues: readonly z.ZodIssue[],
): CompiledDeterministicPolicyBundle {
  return {
    ok: false,
    diagnostics: issues.map((issue) => ({
      kind,
      message: issue.message,
      path: [...issue.path],
    })),
  };
}
