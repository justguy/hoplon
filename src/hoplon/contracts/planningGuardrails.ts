/** contracts/planningGuardrails.ts — FencedContract schema (T-155).
 *
 * FencedContract is the canonical Semantix contract object for goals,
 * boundaries, domain/tool-intent rules, success criteria, and evidence
 * requirements. Identity is `schemaVersion` plus
 * `sha256(stableStringify(canonicalContractWithoutHash))`; clause identity is
 * stable `clauseId`. This module is semantic contract validation only: no NeMo
 * dependency and no `auditDiff` PASS/BLOCK input.
 */

import { createHash } from 'node:crypto';
import { z } from 'zod';
import { stableStringify } from '../util/stableStringify.js';
import { FencedContractClauseSchema } from './planningGuardrailClauses.js';

export {
  FencedContractGoalClauseSchema,
  FencedContractBoundaryClauseSchema,
  FencedContractDomainAllowlistClauseSchema,
  FencedContractDomainDenylistClauseSchema,
  FencedContractToolIntentAllowlistClauseSchema,
  FencedContractToolIntentDenylistClauseSchema,
  FencedContractSuccessCriterionClauseSchema,
  FencedContractEvidenceRequirementClauseSchema,
  FencedContractClauseSchema,
} from './planningGuardrailClauses.js';
export type {
  FencedContractClause,
  FencedContractClauseType,
} from './planningGuardrailClauses.js';

export const FENCED_CONTRACT_SCHEMA_VERSIONS = [
  'hoplon.fenced-contract/v1',
] as const;
export const FencedContractSchemaVersionSchema = z.enum(
  FENCED_CONTRACT_SCHEMA_VERSIONS,
);
export type FencedContractSchemaVersion = z.infer<
  typeof FencedContractSchemaVersionSchema
>;

export const FencedContractProvenanceSchema = z.object({
  semantixVersion: z.string().min(1),
  authoredAt: z.string().datetime({ offset: false }),
  authoredBy: z.string().min(1),
  sourceUri: z.string().min(1).optional(),
}).strict();
export type FencedContractProvenance = z.infer<
  typeof FencedContractProvenanceSchema
>;

export const FencedContractCompilerTargetSchema = z.object({
  compilerId: z.string().min(1),
  compilerVersion: z.string().min(1),
}).strict();
export type FencedContractCompilerTarget = z.infer<
  typeof FencedContractCompilerTargetSchema
>;

const DUPLICATE_CLAUSE_ID_MESSAGE_PREFIX = 'duplicate clauseId: ';

const FencedContractBodyBaseSchema = z.object({
  schemaVersion: FencedContractSchemaVersionSchema,
  contractId: z.string().min(1),
  provenance: FencedContractProvenanceSchema,
  compilerCompatibility: z.array(FencedContractCompilerTargetSchema).min(1),
  clauses: z.array(FencedContractClauseSchema).min(1),
}).strict();
type FencedContractBodyShape = z.infer<typeof FencedContractBodyBaseSchema>;

export const FencedContractBodySchema = FencedContractBodyBaseSchema
  .superRefine(addDuplicateClauseIdIssues);
export type FencedContractBody = FencedContractBodyShape;

export const FencedContractSchema = FencedContractBodyBaseSchema.extend({
  contractHash: z
    .string()
    .regex(/^sha256:[0-9a-f]{64}$/, 'contractHash must be sha256:<64-hex>'),
}).strict().superRefine((contract, ctx) => {
  addDuplicateClauseIdIssues(contract, ctx);
  const body = toFencedContractBody(contract);
  const expected = hashCanonicalFencedContractBody(body);
  if (contract.contractHash !== expected) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      message: 'supplied contractHash does not match canonical hash of body',
      path: ['contractHash'],
    });
  }
});
export type FencedContract = z.infer<typeof FencedContractSchema>;

export const FENCED_CONTRACT_HASH_ALGORITHM = 'sha256' as const;

/**
 * Canonical identity hash. Computed over the body (no `contractHash` field)
 * after stable JSON serialization. Same body → same hash on any platform.
 */
export function hashFencedContract(body: FencedContractBody): string {
  const normalized = FencedContractBodySchema.parse(stripHash(body));
  return hashCanonicalFencedContractBody(normalized);
}

function hashCanonicalFencedContractBody(body: FencedContractBodyShape): string {
  const serialized = stableStringify(body);
  const digest = createHash(FENCED_CONTRACT_HASH_ALGORITHM)
    .update(serialized, 'utf8')
    .digest('hex');
  return `${FENCED_CONTRACT_HASH_ALGORITHM}:${digest}`;
}

export const FENCED_CONTRACT_DIAGNOSTIC_KINDS = [
  'schema_invalid',
  'unsupported_schema_version',
  'prose_only',
  'duplicate_clause_id',
  'hash_mismatch',
] as const;
export const FencedContractDiagnosticKindSchema = z.enum(
  FENCED_CONTRACT_DIAGNOSTIC_KINDS,
);
export type FencedContractDiagnosticKind = z.infer<
  typeof FencedContractDiagnosticKindSchema
>;

export const FencedContractDiagnosticSchema = z.object({
  kind: FencedContractDiagnosticKindSchema,
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
}).strict();
export type FencedContractDiagnostic = z.infer<
  typeof FencedContractDiagnosticSchema
>;

export type ParsedFencedContract =
  | { ok: true; contract: FencedContract; contractHash: string }
  | { ok: false; diagnostics: FencedContractDiagnostic[] };

/**
 * Parse a candidate FencedContract. Fails closed with typed diagnostics on
 * schema invalidity, unsupported version, prose-only output, duplicate
 * clause ids, or supplied-hash mismatch. The returned `contractHash` is
 * authoritative and always matches the contract body.
 *
 * The input may omit `contractHash`; if present it is verified against the
 * recomputed canonical hash.
 */
export function parseFencedContract(input: unknown): ParsedFencedContract {
  try {
    return parseFencedContractUnsafe(input);
  } catch {
    return schemaInvalid('FencedContract input could not be inspected safely');
  }
}

function parseFencedContractUnsafe(input: unknown): ParsedFencedContract {
  // Pre-check the schemaVersion so unsupported versions surface a typed
  // diagnostic instead of generic schema_invalid noise.
  if (hasOwnProperty(input, 'schemaVersion')) {
    const version = readProperty(input, 'schemaVersion');
    if (
      typeof version === 'string'
      && !(FENCED_CONTRACT_SCHEMA_VERSIONS as readonly string[]).includes(version)
    ) {
      return {
        ok: false,
        diagnostics: [{
          kind: 'unsupported_schema_version',
          message: `unsupported FencedContract schemaVersion: ${version}`,
          path: ['schemaVersion'],
          expected: FENCED_CONTRACT_SCHEMA_VERSIONS.join(','),
          actual: version,
        }],
      };
    }
  }

  const inputHasHash = hasOwnProperty(input, 'contractHash');
  const bodyParse = FencedContractBodySchema.safeParse(stripHash(input));
  if (!bodyParse.success) {
    return {
      ok: false,
      diagnostics: bodyParse.error.issues.map(issueToDiagnostic),
    };
  }

  const body = bodyParse.data;
  const contractHash = hashCanonicalFencedContractBody(body);

  if (inputHasHash) {
    const supplied = readProperty(input, 'contractHash');
    if (supplied !== contractHash) {
      return {
        ok: false,
        diagnostics: [{
          kind: 'hash_mismatch',
          message: 'supplied contractHash does not match canonical hash of body',
          path: ['contractHash'],
          expected: contractHash,
          actual: typeof supplied === 'string' ? supplied : String(supplied),
        }],
      };
    }
  }

  return {
    ok: true,
    contract: { ...body, contractHash },
    contractHash,
  };
}

function stripHash(input: unknown): unknown {
  if (!input || typeof input !== 'object') return input;
  const record = input as Record<string, unknown>;
  const rest: Record<string, unknown> = {};
  for (const key of Object.keys(record)) {
    if (key !== 'contractHash') rest[key] = record[key];
  }
  return rest;
}

function hasOwnProperty(input: unknown, property: string): boolean {
  return !!input
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, property);
}

function readProperty(input: unknown, property: string): unknown {
  return (input as Record<string, unknown>)[property];
}

function schemaInvalid(message: string): ParsedFencedContract {
  return {
    ok: false,
    diagnostics: [{ kind: 'schema_invalid', message }],
  };
}

function issueToDiagnostic(issue: z.ZodIssue): FencedContractDiagnostic {
  if (issue.path.length === 1 && issue.path[0] === 'clauses') {
    return {
      kind: 'prose_only',
      message: 'FencedContract has no clauses; prose-only Semantix output is rejected',
      path: [...issue.path],
    };
  }
  if (issue.message.startsWith(DUPLICATE_CLAUSE_ID_MESSAGE_PREFIX)) {
    return {
      kind: 'duplicate_clause_id',
      message: issue.message,
      path: [...issue.path],
      actual: issue.message.replace(DUPLICATE_CLAUSE_ID_MESSAGE_PREFIX, ''),
    };
  }
  return {
    kind: 'schema_invalid',
    message: issue.message,
    path: [...issue.path],
  };
}

function addDuplicateClauseIdIssues(
  body: FencedContractBodyShape,
  ctx: z.RefinementCtx,
): void {
  const seenIds = new Set<string>();
  for (const [index, clause] of body.clauses.entries()) {
    const { clauseId } = clause;
    if (seenIds.has(clauseId)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `${DUPLICATE_CLAUSE_ID_MESSAGE_PREFIX}${clauseId}`,
        path: ['clauses', index, 'clauseId'],
      });
    }
    seenIds.add(clauseId);
  }
}

function toFencedContractBody(
  contract: FencedContractBodyShape & { contractHash: string },
): FencedContractBodyShape {
  return {
    schemaVersion: contract.schemaVersion,
    contractId: contract.contractId,
    provenance: contract.provenance,
    compilerCompatibility: contract.compilerCompatibility,
    clauses: contract.clauses,
  };
}
