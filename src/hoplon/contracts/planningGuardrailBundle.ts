/** contracts/planningGuardrailBundle.ts — PlanningGuardrailBundle DTO (T-156).
 *
 * Compiled, NeMo-runtime-facing artifact derived from a versioned
 * FencedContract. Identity is `schemaVersion` plus
 * `sha256(stableStringify(canonicalBundleWithoutHash))`. The bundle binds a
 * particular contract version (`contractHash`), the compiler that produced it,
 * the rail/config configuration handed to NeMo, and an `enforcementMode`.
 *
 * Hoplon does not host NeMo and does not consume this DTO inside its
 * deterministic kernel. `evidenceAuthority` is locked to `'advisory'` so
 * downstream consumers cannot mistake the bundle for an `auditDiff`
 * PASS/BLOCK input. Promotion of any rail to a blocking gate is a separate
 * hard-gate slice (ct-mcp review bundle + adversarial corpus + approval).
 *
 * Diagnostic typing and the safe `parsePlanningGuardrailBundle` parser live
 * alongside in `planningGuardrailBundleParser.ts` to keep this file under the
 * 300-line architecture limit.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../util/stableStringify.js';

export const PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS = [
  'hoplon.planning-guardrail-bundle/v1',
] as const;
export const PlanningGuardrailBundleSchemaVersionSchema = z.enum(
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
);
export type PlanningGuardrailBundleSchemaVersion = z.infer<
  typeof PlanningGuardrailBundleSchemaVersionSchema
>;

export const PLANNING_GUARDRAIL_ENFORCEMENT_MODES = [
  'advisory',
  'block',
] as const;
export const PlanningGuardrailEnforcementModeSchema = z.enum(
  PLANNING_GUARDRAIL_ENFORCEMENT_MODES,
);
export type PlanningGuardrailEnforcementMode = z.infer<
  typeof PlanningGuardrailEnforcementModeSchema
>;

export const PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY = 'advisory' as const;
/**
 * Locked literal until a separate hard-gate slice proves blocking precision.
 * `enforcementMode` is the planner-facing setting NeMo runs under;
 * `evidenceAuthority` is the Hoplon-facing classification of the record.
 * Planner-side blocking does not authorize deterministic gate behavior.
 */
export const PlanningGuardrailEvidenceAuthoritySchema = z.literal(
  PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
);
export type PlanningGuardrailEvidenceAuthority = z.infer<
  typeof PlanningGuardrailEvidenceAuthoritySchema
>;

const ClauseIdSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/,
  'clauseId must match /^[A-Za-z][A-Za-z0-9_.-]{0,63}$/',
);
const RailIdSchema = z.string().regex(
  /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/,
  'railId must match /^[A-Za-z][A-Za-z0-9_.-]{0,127}$/',
);
const sha256HexSchema = (label: string) => z
  .string()
  .regex(/^sha256:[0-9a-f]{64}$/, `${label} must be sha256:<64-hex>`);

export const PlanningGuardrailTargetRuntimeSchema = z.object({
  runtimeId: z.string().min(1),
  runtimeVersion: z.string().min(1),
}).strict();
export type PlanningGuardrailTargetRuntime = z.infer<
  typeof PlanningGuardrailTargetRuntimeSchema
>;

export const PLANNING_GUARDRAIL_GENERATED_CONFIG_KINDS = [
  'rails_config',
  'colang_flow',
  'rail_action',
  'auxiliary',
] as const;
export const PlanningGuardrailGeneratedConfigKindSchema = z.enum(
  PLANNING_GUARDRAIL_GENERATED_CONFIG_KINDS,
);
export const PlanningGuardrailGeneratedConfigSchema = z.object({
  configKind: PlanningGuardrailGeneratedConfigKindSchema,
  configRef: z.string().min(1),
  configHash: sha256HexSchema('configHash'),
}).strict();
export type PlanningGuardrailGeneratedConfig = z.infer<
  typeof PlanningGuardrailGeneratedConfigSchema
>;

export const PlanningGuardrailClauseRailMappingSchema = z.object({
  clauseId: ClauseIdSchema,
  railIds: z.array(RailIdSchema).min(1),
}).strict();
export type PlanningGuardrailClauseRailMapping = z.infer<
  typeof PlanningGuardrailClauseRailMappingSchema
>;

export const DUPLICATE_CLAUSE_ID_PREFIX = 'duplicate clauseId: ';
export const DUPLICATE_RAIL_ID_PREFIX = 'duplicate railId: ';
export const DUPLICATE_CONFIG_HASH_PREFIX = 'duplicate configHash: ';

const PlanningGuardrailBundleBodyBaseSchema = z.object({
  schemaVersion: PlanningGuardrailBundleSchemaVersionSchema,
  contractHash: sha256HexSchema('contractHash'),
  compilerId: z.string().min(1),
  compilerVersion: z.string().min(1),
  targetRuntime: PlanningGuardrailTargetRuntimeSchema,
  generatedConfigs: z.array(PlanningGuardrailGeneratedConfigSchema).min(1),
  clauseToRailMap: z.array(PlanningGuardrailClauseRailMappingSchema).min(1),
  enforcementMode: PlanningGuardrailEnforcementModeSchema,
  evidenceAuthority: PlanningGuardrailEvidenceAuthoritySchema,
}).strict();
type PlanningGuardrailBundleBodyShape = z.infer<
  typeof PlanningGuardrailBundleBodyBaseSchema
>;

export const PlanningGuardrailBundleBodySchema = PlanningGuardrailBundleBodyBaseSchema
  .superRefine(addDuplicateBundleIssues);
export type PlanningGuardrailBundleBody = PlanningGuardrailBundleBodyShape;

export const PlanningGuardrailBundleSchema = PlanningGuardrailBundleBodyBaseSchema.extend({
  bundleHash: sha256HexSchema('bundleHash'),
}).strict().superRefine((bundle, ctx) => {
  addDuplicateBundleIssues(bundle, ctx);
  const expected = hashCanonicalPlanningGuardrailBundleBody(toBundleBody(bundle));
  if (bundle.bundleHash !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'supplied bundleHash does not match canonical hash of body',
      path: ['bundleHash'],
    });
  }
});
export type PlanningGuardrailBundle = z.infer<typeof PlanningGuardrailBundleSchema>;

export const PLANNING_GUARDRAIL_BUNDLE_HASH_ALGORITHM = 'sha256' as const;

/**
 * Canonical identity hash. Same body → same hash on any platform; mirrors
 * `hashFencedContract`. Strips any caller-supplied `bundleHash` before
 * hashing so the function is stable under round-trip serialization.
 */
export function hashPlanningGuardrailBundle(
  body: PlanningGuardrailBundleBody,
): string {
  const normalized = PlanningGuardrailBundleBodySchema.parse(stripBundleHash(body));
  return hashCanonicalPlanningGuardrailBundleBody(normalized);
}

export function hashCanonicalPlanningGuardrailBundleBody(
  body: PlanningGuardrailBundleBodyShape,
): string {
  const serialized = stableStringify(body);
  const digest = createHash(PLANNING_GUARDRAIL_BUNDLE_HASH_ALGORITHM)
    .update(serialized, 'utf8')
    .digest('hex');
  return `${PLANNING_GUARDRAIL_BUNDLE_HASH_ALGORITHM}:${digest}`;
}

export function stripBundleHash(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'bundleHash') rest[key] = record[key];
  }
  return rest;
}

function toBundleBody(
  bundle: PlanningGuardrailBundleBodyShape & { bundleHash: string },
): PlanningGuardrailBundleBodyShape {
  return {
    schemaVersion: bundle.schemaVersion,
    contractHash: bundle.contractHash,
    compilerId: bundle.compilerId,
    compilerVersion: bundle.compilerVersion,
    targetRuntime: bundle.targetRuntime,
    generatedConfigs: bundle.generatedConfigs,
    clauseToRailMap: bundle.clauseToRailMap,
    enforcementMode: bundle.enforcementMode,
    evidenceAuthority: bundle.evidenceAuthority,
  };
}

function addDuplicateBundleIssues(
  body: PlanningGuardrailBundleBodyShape,
  ctx: z.RefinementCtx,
): void {
  const seenClauseIds = new Set<string>();
  for (const [index, mapping] of body.clauseToRailMap.entries()) {
    if (seenClauseIds.has(mapping.clauseId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${DUPLICATE_CLAUSE_ID_PREFIX}${mapping.clauseId}`,
        path: ['clauseToRailMap', index, 'clauseId'],
      });
    }
    seenClauseIds.add(mapping.clauseId);

    const seenRails = new Set<string>();
    for (const [railIndex, railId] of mapping.railIds.entries()) {
      if (seenRails.has(railId)) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          message: `${DUPLICATE_RAIL_ID_PREFIX}${railId}`,
          path: ['clauseToRailMap', index, 'railIds', railIndex],
        });
      }
      seenRails.add(railId);
    }
  }

  const seenConfigHashes = new Set<string>();
  for (const [index, config] of body.generatedConfigs.entries()) {
    if (seenConfigHashes.has(config.configHash)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${DUPLICATE_CONFIG_HASH_PREFIX}${config.configHash}`,
        path: ['generatedConfigs', index, 'configHash'],
      });
    }
    seenConfigHashes.add(config.configHash);
  }
}
