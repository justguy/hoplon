/** contracts/planningGuardrailCompiler.ts - optional Semantix-to-NeMo boundary.
 *
 * Pure compiler helper from an already-extracted FencedContract candidate to a
 * PlanningGuardrailBundle plus generated artifact contents. This module owns no
 * NeMo runtime, filesystem writes, router behavior, auditDiff input, or
 * deterministic execution gate. Unsupported clauses fail closed with typed
 * diagnostics instead of being silently omitted from the planning bundle.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../util/stableStringify.js';
import {
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
  PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
  PlanningGuardrailBundleSchema,
  PlanningGuardrailEnforcementModeSchema,
  PlanningGuardrailGeneratedConfigSchema,
  PlanningGuardrailTargetRuntimeSchema,
  hashPlanningGuardrailBundle,
  type PlanningGuardrailBundle,
  type PlanningGuardrailGeneratedConfig,
} from './planningGuardrailBundle.js';
import {
  parseFencedContract,
  type FencedContract,
  type FencedContractClause,
  type FencedContractClauseType,
  type FencedContractDiagnostic,
} from './planningGuardrails.js';

export const PLANNING_GUARDRAIL_COMPILER_ID = 'semantix-to-nemo' as const;
export const PLANNING_GUARDRAIL_COMPILER_DIAGNOSTIC_KINDS = [
  'request_invalid',
  'contract_invalid',
  'compiler_incompatible',
  'unsupported_clause_type',
  'bundle_invalid',
] as const;
export const PlanningGuardrailCompilerDiagnosticKindSchema = z.enum(
  PLANNING_GUARDRAIL_COMPILER_DIAGNOSTIC_KINDS,
);
export type PlanningGuardrailCompilerDiagnosticKind = z.infer<
  typeof PlanningGuardrailCompilerDiagnosticKindSchema
>;

export const PlanningGuardrailCompilerDiagnosticSchema = z.object({
  kind: PlanningGuardrailCompilerDiagnosticKindSchema,
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  clauseId: z.string().optional(),
  clauseType: z.string().optional(),
  upstreamKind: z.string().optional(),
}).strict();
export type PlanningGuardrailCompilerDiagnostic = z.infer<
  typeof PlanningGuardrailCompilerDiagnosticSchema
>;

export const PlanningGuardrailCompilerRequestSchema = z.object({
  contract: z.unknown(),
  compilerId: z.string().min(1),
  compilerVersion: z.string().min(1),
  targetRuntime: PlanningGuardrailTargetRuntimeSchema,
  enforcementMode: PlanningGuardrailEnforcementModeSchema,
  configRefPrefix: z.string().min(1),
}).strict();
export type PlanningGuardrailCompilerRequest = z.infer<
  typeof PlanningGuardrailCompilerRequestSchema
>;

export const PlanningGuardrailGeneratedArtifactSchema =
  PlanningGuardrailGeneratedConfigSchema.extend({
    content: z.string().min(1),
  }).strict();
export type PlanningGuardrailGeneratedArtifact = z.infer<
  typeof PlanningGuardrailGeneratedArtifactSchema
>;

export type CompiledPlanningGuardrailBundle =
  | {
    ok: true;
    bundle: PlanningGuardrailBundle;
    bundleHash: string;
    generatedArtifacts: PlanningGuardrailGeneratedArtifact[];
  }
  | { ok: false; diagnostics: PlanningGuardrailCompilerDiagnostic[] };

export const PLANNING_GUARDRAIL_COMPILER_SUPPORTED_CLAUSE_TYPES = [
  'goal',
  'domain_allowlist',
  'domain_denylist',
  'tool_intent_allowlist',
  'tool_intent_denylist',
] as const satisfies readonly FencedContractClauseType[];
type SupportedPlanningClause = Extract<
  FencedContractClause,
  { clauseType: typeof PLANNING_GUARDRAIL_COMPILER_SUPPORTED_CLAUSE_TYPES[number] }
>;

export function compileFencedContractToPlanningGuardrailBundle(
  input: unknown,
): CompiledPlanningGuardrailBundle {
  const requestParse = PlanningGuardrailCompilerRequestSchema.safeParse(input);
  if (!requestParse.success) {
    return diagnosticsFromZod('request_invalid', requestParse.error.issues);
  }

  const request = requestParse.data;
  const contractParse = parseFencedContract(request.contract);
  if (!contractParse.ok) {
    return {
      ok: false,
      diagnostics: contractParse.diagnostics.map(contractDiagnostic),
    };
  }

  const { contract } = contractParse;
  if (!supportsCompiler(contract, request.compilerId, request.compilerVersion)) {
    return {
      ok: false,
      diagnostics: [{
        kind: 'compiler_incompatible',
        message: 'FencedContract compilerCompatibility does not include this compiler',
        path: ['compilerCompatibility'],
      }],
    };
  }

  const railMap: Array<{ clauseId: string; railIds: string[] }> = [];
  const railDefinitions: RailDefinition[] = [];
  for (const [index, clause] of contract.clauses.entries()) {
    if (!isSupportedPlanningClause(clause)) {
      return {
        ok: false,
        diagnostics: [{
          kind: 'unsupported_clause_type',
          message: `unsupported planning guardrail clauseType: ${clause.clauseType}`,
          path: ['clauses', index, 'clauseType'],
          clauseId: clause.clauseId,
          clauseType: clause.clauseType,
        }],
      };
    }
    const railId = railIdForClause(clause);
    railMap.push({ clauseId: clause.clauseId, railIds: [railId] });
    railDefinitions.push({
      railId,
      clauseId: clause.clauseId,
      clauseType: clause.clauseType,
      description: clause.description,
      values: valuesForClause(clause),
    });
  }

  const generatedArtifacts = buildArtifacts(request.configRefPrefix, railDefinitions);
  const generatedConfigs = generatedArtifacts.map(toGeneratedConfig);
  const body = {
    schemaVersion: PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS[0],
    contractHash: contract.contractHash,
    compilerId: request.compilerId,
    compilerVersion: request.compilerVersion,
    targetRuntime: request.targetRuntime,
    generatedConfigs,
    clauseToRailMap: railMap,
    enforcementMode: request.enforcementMode,
    evidenceAuthority: PLANNING_GUARDRAIL_EVIDENCE_AUTHORITY,
  };
  const bundleHash = hashPlanningGuardrailBundle(body);
  const bundleParse = PlanningGuardrailBundleSchema.safeParse({ ...body, bundleHash });
  if (!bundleParse.success) {
    return diagnosticsFromZod('bundle_invalid', bundleParse.error.issues);
  }
  return {
    ok: true,
    bundle: bundleParse.data,
    bundleHash,
    generatedArtifacts,
  };
}

interface RailDefinition {
  railId: string;
  clauseId: string;
  clauseType: SupportedPlanningClause['clauseType'];
  description: string;
  values: readonly string[];
}

function supportsCompiler(
  contract: FencedContract,
  compilerId: string,
  compilerVersion: string,
): boolean {
  return contract.compilerCompatibility.some((target) => (
    target.compilerId === compilerId && target.compilerVersion === compilerVersion
  ));
}

function isSupportedPlanningClause(
  clause: FencedContractClause,
): clause is SupportedPlanningClause {
  return (PLANNING_GUARDRAIL_COMPILER_SUPPORTED_CLAUSE_TYPES as readonly string[])
    .includes(clause.clauseType);
}

function railIdForClause(clause: SupportedPlanningClause): string {
  return `rail.${clause.clauseType}.${clause.clauseId}`;
}

function valuesForClause(clause: SupportedPlanningClause): readonly string[] {
  if (clause.clauseType === 'goal') return [clause.goalKind, clause.description];
  if (clause.clauseType === 'domain_allowlist') return clause.domains;
  if (clause.clauseType === 'domain_denylist') return clause.domains;
  if (clause.clauseType === 'tool_intent_allowlist') return clause.toolIntents;
  return clause.toolIntents;
}

function buildArtifacts(
  prefix: string,
  rails: readonly RailDefinition[],
): PlanningGuardrailGeneratedArtifact[] {
  const railConfigRef = `${prefix}/rails.json`;
  const flowRef = `${prefix}/flows.co`;
  return [
    buildArtifact('rails_config', railConfigRef, stableStringify({
      schemaVersion: 'hoplon.generated-nemo-rails/v1',
      rails,
      flowRef,
    })),
    buildArtifact('colang_flow', flowRef, rails.map((rail) => [
      `define flow ${rail.railId.replaceAll('.', '_')}`,
      `  # clauseId: ${rail.clauseId}`,
      `  # clauseType: ${rail.clauseType}`,
      `  # description: ${rail.description}`,
      '  bot allow',
    ].join('\n')).join('\n\n')),
  ];
}

function buildArtifact(
  configKind: PlanningGuardrailGeneratedConfig['configKind'],
  configRef: string,
  content: string,
): PlanningGuardrailGeneratedArtifact {
  return { configKind, configRef, configHash: hashText(content), content };
}

function toGeneratedConfig(
  artifact: PlanningGuardrailGeneratedArtifact,
): PlanningGuardrailGeneratedConfig {
  return {
    configKind: artifact.configKind,
    configRef: artifact.configRef,
    configHash: artifact.configHash,
  };
}

function hashText(content: string): string {
  return `sha256:${createHash('sha256').update(content, 'utf8').digest('hex')}`;
}

function contractDiagnostic(
  diagnostic: FencedContractDiagnostic,
): PlanningGuardrailCompilerDiagnostic {
  return {
    kind: 'contract_invalid',
    message: diagnostic.message,
    path: diagnostic.path,
    upstreamKind: diagnostic.kind,
  };
}

function diagnosticsFromZod(
  kind: PlanningGuardrailCompilerDiagnostic['kind'],
  issues: readonly z.ZodIssue[],
): CompiledPlanningGuardrailBundle {
  return {
    ok: false,
    diagnostics: issues.map((issue) => ({
      kind,
      message: issue.message,
      path: [...issue.path],
    })),
  };
}
