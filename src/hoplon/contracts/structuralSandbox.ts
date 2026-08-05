/**
 * contracts/structuralSandbox.ts - t-108 ephemeral structural sandbox DTOs.
 *
 * The sandbox is a read-only planning macro for synthetic snippets. It parses
 * caller-supplied content in memory and reports parse/structure compatibility.
 * It is not a compiler proof, cannot mutate project state, and cannot replace
 * dryRun, auditDiff, policy checks, or session_apply_edits.
 */

import { z } from 'zod';
import {
  AdvisoryIntelligenceAuthoritySchema,
  createAdvisoryIntelligenceAuthority,
} from './advisoryIntelligence.js';
import { SUPPORTED_QUERY_LANGUAGES } from './queryStructure.js';

export const SandboxLanguageSchema = z.enum(SUPPORTED_QUERY_LANGUAGES);
export type SandboxLanguage = z.infer<typeof SandboxLanguageSchema>;

export const StructuralSandboxExpectationsSchema = z.object({
  rootKind: z.string().min(1).optional(),
  requiredNodeKinds: z.array(z.string().min(1)).optional(),
  requiredTopLevelSymbols: z.array(z.string().min(1)).optional(),
});
export type StructuralSandboxExpectations = z.infer<
  typeof StructuralSandboxExpectationsSchema
>;

export const StructuralSandboxSnippetSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  language: SandboxLanguageSchema.optional(),
  content: z.string(),
  expectations: StructuralSandboxExpectationsSchema.optional(),
});
export type StructuralSandboxSnippet = z.infer<
  typeof StructuralSandboxSnippetSchema
>;

export const StructuralSandboxOptionsSchema = z.object({
  includeTypeProviderCheck: z.boolean().optional(),
});
export type StructuralSandboxOptions = z.infer<
  typeof StructuralSandboxOptionsSchema
>;

export const EphemeralStructuralSandboxRequestSchema = z.object({
  correlationId: z.string().min(1),
  projectId: z.string().min(1).optional(),
  runId: z.string().min(1).optional(),
  snippets: z.array(StructuralSandboxSnippetSchema).min(1),
  options: StructuralSandboxOptionsSchema.optional(),
});
export type EphemeralStructuralSandboxRequest = z.infer<
  typeof EphemeralStructuralSandboxRequestSchema
>;

export const StructuralSandboxStatusSchema = z.enum([
  'PARSE_AND_STRUCTURE_OK',
  'PARSE_OR_STRUCTURE_ISSUES',
  'DEGRADED',
]);
export type StructuralSandboxStatus = z.infer<
  typeof StructuralSandboxStatusSchema
>;

export const StructuralSandboxSnippetStatusSchema = z.enum([
  'STRUCTURE_OK',
  'STRUCTURE_ISSUES',
  'PARSE_FAILED',
  'DEGRADED',
]);
export type StructuralSandboxSnippetStatus = z.infer<
  typeof StructuralSandboxSnippetStatusSchema
>;

export const StructuralSandboxParseCheckSchema = z.object({
  status: z.enum(['OK', 'FAILED']),
  parser: z.literal('codeIntelligence.parse'),
  language: SandboxLanguageSchema.nullable(),
  errorMessage: z.string().min(1).nullable(),
});
export type StructuralSandboxParseCheck = z.infer<
  typeof StructuralSandboxParseCheckSchema
>;

export const StructuralSandboxSymbolSchema = z.object({
  name: z.string().min(1),
  kind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
});
export type StructuralSandboxSymbol = z.infer<
  typeof StructuralSandboxSymbolSchema
>;

export const StructuralSandboxExpectationFailureSchema = z.object({
  kind: z.enum(['root_kind_mismatch', 'missing_node_kind', 'missing_top_level_symbol']),
  expected: z.string().min(1),
  actual: z.string().min(1).nullable(),
  message: z.string().min(1),
});
export type StructuralSandboxExpectationFailure = z.infer<
  typeof StructuralSandboxExpectationFailureSchema
>;

export const StructuralSandboxStructureCheckSchema = z.object({
  status: z.enum(['OK', 'ISSUES', 'UNAVAILABLE']),
  rootKind: z.string().min(1).nullable(),
  nodeKindCounts: z.record(z.number().int().nonnegative()),
  errorNodeCount: z.number().int().nonnegative(),
  topLevelSymbols: z.array(StructuralSandboxSymbolSchema),
  expectationFailures: z.array(StructuralSandboxExpectationFailureSchema),
});
export type StructuralSandboxStructureCheck = z.infer<
  typeof StructuralSandboxStructureCheckSchema
>;

export const StructuralSandboxSnippetResultSchema = z.object({
  id: z.string().min(1),
  path: z.string().min(1),
  status: StructuralSandboxSnippetStatusSchema,
  parse: StructuralSandboxParseCheckSchema,
  structure: StructuralSandboxStructureCheckSchema,
});
export type StructuralSandboxSnippetResult = z.infer<
  typeof StructuralSandboxSnippetResultSchema
>;

export const StructuralSandboxTypeProviderCheckSchema = z.object({
  status: z.enum(['NOT_REQUESTED', 'UNAVAILABLE', 'DEGRADED']),
  providerId: z.string().min(1).nullable(),
  reason: z.string().min(1).nullable(),
  compilerProof: z.literal(false),
});
export type StructuralSandboxTypeProviderCheck = z.infer<
  typeof StructuralSandboxTypeProviderCheckSchema
>;

export const StructuralSandboxSideEffectProfileSchema = z.object({
  inMemoryOnly: z.literal(true),
  detachedAstContext: z.literal(true),
  usesFilesystem: z.literal(false),
  usesVersioning: z.literal(false),
  usesSnapshotStore: z.literal(false),
  usesAuditLog: z.literal(false),
  usesSessionMutation: z.literal(false),
  usesLocks: z.literal(false),
});
export type StructuralSandboxSideEffectProfile = z.infer<
  typeof StructuralSandboxSideEffectProfileSchema
>;

export const StructuralSandboxNonBypassSchema = z.object({
  doesNotReplace: z.tuple([
    z.literal('dryRun'),
    z.literal('auditDiff'),
    z.literal('policy'),
    z.literal('session_apply_edits'),
  ]),
  successCannotAuthorizeWrites: z.literal(true),
});
export type StructuralSandboxNonBypass = z.infer<
  typeof StructuralSandboxNonBypassSchema
>;

export const EphemeralStructuralSandboxResultSchema = z.object({
  sandboxSchemaVersion: z.literal(1),
  correlationId: z.string().min(1),
  advisory: z.literal(true),
  status: StructuralSandboxStatusSchema,
  checked: z.number().int().nonnegative(),
  snippets: z.array(StructuralSandboxSnippetResultSchema),
  typeProvider: StructuralSandboxTypeProviderCheckSchema,
  sideEffectProfile: StructuralSandboxSideEffectProfileSchema,
  authority: AdvisoryIntelligenceAuthoritySchema,
  nonBypass: StructuralSandboxNonBypassSchema,
});
export type EphemeralStructuralSandboxResult = z.infer<
  typeof EphemeralStructuralSandboxResultSchema
>;

export function createStructuralSandboxSideEffectProfile():
  StructuralSandboxSideEffectProfile {
  return {
    inMemoryOnly: true,
    detachedAstContext: true,
    usesFilesystem: false,
    usesVersioning: false,
    usesSnapshotStore: false,
    usesAuditLog: false,
    usesSessionMutation: false,
    usesLocks: false,
  };
}

export function createStructuralSandboxNonBypass(): StructuralSandboxNonBypass {
  return {
    doesNotReplace: ['dryRun', 'auditDiff', 'policy', 'session_apply_edits'],
    successCannotAuthorizeWrites: true,
  };
}

export { createAdvisoryIntelligenceAuthority };
