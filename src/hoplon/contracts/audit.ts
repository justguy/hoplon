/**
 * audit.ts — AuditResult and AuditViolation Zod schemas and inferred types.
 *
 * AuditViolation is a discriminated union. Every variant carries both
 * message (context) and correction (mechanical directive) as mandatory
 * string fields.
 *
 * AuditResult carries auditSchemaVersion: 1 and correlationId on both
 * PASS and BLOCK variants (H8, H11).
 *
 * The kind field is a closed string-literal union — TypeScript rejects
 * unknown kinds at compile time, structural guard against silent drift.
 *
 * PHASE 1 CANONICAL KINDS (permanent — never renamed):
 *   'out_of_scope_symbol'   — symbol edited outside contracted scope
 *   'uncontracted_file'     — file modified outside manifest
 *   'parse_failure'         — tree-sitter parse failed (AS-3)
 *   'snapshot_missing'      — snapshot not found in store
 *
 * PHASE 2 ADDITIVE KINDS (schemas in auditViolationsPhase2.ts):
 *   'SCOPE_ESCAPE'              — scope-escaping node (structural)
 *   'STRUCTURAL_CORRUPTION'     — malformed structural unit after edit
 *   'PATH_ESCAPE'               — path traversal at audit time (H9 defense-in-depth)
 *   'SIGNATURE_MISMATCH'        — signature contract violated (LC3)
 *   'SIGNATURE_UNCERTAIN'       — ambiguous generic/overload comparison (LC3)
 *   'TARGET_NOT_FOUND'          — modify target does not exist in snapshot (LC1)
 *   'DUPLICATE_TARGET'          — create target already exists in snapshot (LC1)
 *   'IMPORT_TARGET_NOT_FOUND'   — imported file missing from snapshot (LC2)
 *   'IMPORT_SYMBOL_NOT_EXPORTED'— imported symbol not exported by target file (LC2)
 *   'IMPORT_ALIAS_UNRESOLVED'   — tsconfig path alias unresolvable in Phase 2 (LC2)
 *
 * RECS-SPEC INPUT ALIASES (H18 — additive, normalised on input, never surfaced on output):
 *   Input 'UNCONTRACTED_SYMBOL' is normalised to shipped canonical 'out_of_scope_symbol'
 *   before the discriminated union parses it. Downstream consumers never observe the alias
 *   name; all outputs use the shipped canonical kind.
 *
 *   Input 'SCOPE_ESCAPE' is already a shipped Phase 2 kind (see auditViolationsPhase2.ts)
 *   and is accepted as-is — no normalisation step required for this alias.
 *
 *   These aliases exist because the recommendations spec (HOPLON_COMPLETE_RECOMMENDATIONS.md)
 *   used 'UNCONTRACTED_SYMBOL' and 'SCOPE_ESCAPE' before the Phase 1 shipped names were
 *   settled. Hosts that wrote against the recs spec can pass either name; outputs always
 *   use the canonical shipped name. No shipped kind is ever renamed (H18 invariant).
 *
 * Consumers doing exhaustive switch on kind will now receive TypeScript
 * errors for the new Phase 2 kinds — that is correct behavior. They must
 * handle all variants. Callers that only check specific kinds by name are
 * unaffected.
 */

import { z } from 'zod';
import { ManifestScopeSchema } from './manifest.js';
import { AuditCoverageEvidenceSchema } from './auditCoverage.js';
import {
  AuditViolationScopeEscapeSchema,
  AuditViolationStructuralCorruptionSchema,
  AuditViolationPathEscapeSchema,
  AuditViolationSignatureMismatchSchema,
  AuditViolationSignatureUncertainSchema,
  AuditViolationTargetNotFoundSchema,
  AuditViolationDuplicateTargetSchema,
  AuditViolationImportTargetNotFoundSchema,
  AuditViolationImportSymbolNotExportedSchema,
  AuditViolationImportAliasUnresolvedSchema,
} from './auditViolationsPhase2.js';

// Re-export Phase 2 schemas so the public surface is still a single import point.
export {
  AuditViolationScopeEscapeSchema,
  AuditViolationStructuralCorruptionSchema,
  AuditViolationPathEscapeSchema,
  AuditViolationSignatureMismatchSchema,
  AuditViolationSignatureUncertainSchema,
  AuditViolationTargetNotFoundSchema,
  AuditViolationDuplicateTargetSchema,
  AuditViolationImportTargetNotFoundSchema,
  AuditViolationImportSymbolNotExportedSchema,
  AuditViolationImportAliasUnresolvedSchema,
} from './auditViolationsPhase2.js';
export {
  AUDIT_COVERAGE_PARTIAL_REASONS,
  AuditCoverageEvidenceSchema,
} from './auditCoverage.js';
export type { AuditCoverageEvidence } from './auditCoverage.js';

// ---------------------------------------------------------------------------
// Phase 1 AuditViolation variants (canonical — never renamed)
// ---------------------------------------------------------------------------

/** Symbol edited outside the contracted scope for that file. */
export const AuditViolationOutOfScopeSymbolSchema = z.object({
  kind: z.literal('out_of_scope_symbol'),
  path: z.string().min(1),
  symbolName: z.string().min(1),
  /** tree-sitter node kind, e.g. 'function_declaration' */
  nodeKind: z.string().min(1),
  /** Byte range [start, end) of the violating node within the file. */
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  /**
   * Full verbatim source of the changed symbol. Never truncated — agent-facing
   * audit evidence carries the complete slice (hcr-002 / AGENTS.md rule).
   */
  sourceSlice: z.string(),
  /**
   * Legacy flag from the pre-hcr-002 4 KB cap. No longer produced; accepted
   * for backward compatibility with previously stored payloads.
   */
  truncated: z.boolean().optional(),
  /**
   * How the symbol diverged from the snapshot baseline (hcr-002 true diff):
   * 'added' (absent from baseline), 'removed' (deleted from the evaluated
   * state — byteRange/sourceSlice refer to the baseline), or 'modified'.
   * Optional: absent on payloads produced before the diff-based gate.
   */
  changeType: z.enum(['added', 'removed', 'modified']).optional(),
  /** The contracted scope for this file that the edit violated. */
  expectedScope: ManifestScopeSchema,
  /** CONTEXT: what was detected, single sentence. */
  message: z.string().min(1),
  /** DIRECTIVE: mechanical inverse of the violation, single sentence. */
  correction: z.string().min(1),
});

/** File was modified that is not in the manifest at all. */
export const AuditViolationUncontractedFileSchema = z.object({
  kind: z.literal('uncontracted_file'),
  path: z.string().min(1),
  firstChangedLine: z.number().int().nonnegative(),
  sourceSlice: z.string(),
  truncated: z.boolean().optional(),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/** File could not be parsed by tree-sitter. */
export const AuditViolationParseFailureSchema = z.object({
  kind: z.literal('parse_failure'),
  path: z.string().min(1),
  parseError: z.string().min(1),
  /** tree-sitter node kind at the error site, or null if unavailable. */
  nodeKind: z.union([z.string().min(1), z.null()]),
  message: z.string().min(1),
  correction: z.string().min(1),
});

/** Snapshot referenced in the audit call is not in the store. */
export const AuditViolationSnapshotMissingSchema = z.object({
  kind: z.literal('snapshot_missing'),
  path: z.string().min(1),
  snapshotRefId: z.string().min(1),
  message: z.string().min(1),
  correction: z.string().min(1),
});

// ---------------------------------------------------------------------------
// AuditViolation — discriminated union (Phase 1 + Phase 2 additive)
// ---------------------------------------------------------------------------

/**
 * Recs-spec alias → shipped canonical kind normalisation (H18).
 *
 * Applied as a Zod preprocess step before the discriminated union parses
 * the input. Only the `kind` field is touched; all other fields pass through
 * unchanged. Outputs always use shipped canonical kind names.
 *
 * Alias map (input → canonical):
 *   'UNCONTRACTED_SYMBOL' → 'out_of_scope_symbol'
 *
 * 'SCOPE_ESCAPE' is already a shipped Phase 2 canonical kind and requires
 * no normalisation — it is accepted by the discriminated union directly.
 */
function normaliseAuditViolationKind(raw: unknown): unknown {
  if (typeof raw !== 'object' || raw === null || !('kind' in raw)) {
    return raw;
  }
  const obj = raw as Record<string, unknown>;
  if (obj['kind'] === 'UNCONTRACTED_SYMBOL') {
    return { ...obj, kind: 'out_of_scope_symbol' };
  }
  return raw;
}

/**
 * Raw discriminated union of all AuditViolation variants.
 *
 * Exposed for structural inspection (e.g. exhaustive kind-count tests that
 * need access to `.optionsMap`). For parsing, always use `AuditViolationSchema`
 * which includes H18 alias normalisation.
 */
export const AuditViolationUnionSchema = z.discriminatedUnion('kind', [
  // Phase 1 canonical kinds — permanent, never renamed
  AuditViolationOutOfScopeSymbolSchema,
  AuditViolationUncontractedFileSchema,
  AuditViolationParseFailureSchema,
  AuditViolationSnapshotMissingSchema,
  // Phase 2 additive kinds (schemas in auditViolationsPhase2.ts)
  AuditViolationScopeEscapeSchema,
  AuditViolationStructuralCorruptionSchema,
  AuditViolationPathEscapeSchema,
  AuditViolationSignatureMismatchSchema,
  AuditViolationSignatureUncertainSchema,
  AuditViolationTargetNotFoundSchema,
  AuditViolationDuplicateTargetSchema,
  AuditViolationImportTargetNotFoundSchema,
  AuditViolationImportSymbolNotExportedSchema,
  AuditViolationImportAliasUnresolvedSchema,
]);

/**
 * AuditViolation schema with H18 alias normalisation.
 *
 * **Input:** accepts both shipped canonical kind names and recs-spec alias
 * names (e.g. `UNCONTRACTED_SYMBOL`). Aliases are silently normalised to
 * the canonical shipped name before validation.
 *
 * **Output / inferred type:** always uses shipped canonical kind names.
 * Downstream consumers never observe alias names.
 *
 * See the file-level JSDoc for the full alias map.
 */
export const AuditViolationSchema = z.preprocess(
  normaliseAuditViolationKind,
  AuditViolationUnionSchema,
);

export type AuditViolation = z.infer<typeof AuditViolationUnionSchema>;

// ---------------------------------------------------------------------------
// AuditResult — PASS / BLOCK discriminated union (H8, H11)
// ---------------------------------------------------------------------------

export const AuditResultPassSchema = z.object({
  status: z.literal('PASS'),
  /** Number of files checked. */
  checked: z.number().int().nonnegative(),
  /** Schema version flow-through (H8). Phase 1 = 1. */
  auditSchemaVersion: z.literal(1),
  /** Correlation ID threaded from the request (H11). */
  correlationId: z.string().min(1),
  /**
   * Durable hoplon_audit_log row id when auditDiff successfully appends its
   * best-effort audit log record. Null when the log write failed; optional to
   * keep pre-existing mock/result fixtures source-compatible.
   */
  auditRef: z.string().min(1).nullable().optional(),
  /** hcr-005 derived-coverage evidence. Optional for transport compat. */
  coverage: AuditCoverageEvidenceSchema.optional(),
});

export const AuditResultBlockSchema = z.object({
  status: z.literal('BLOCK'),
  violations: z.array(AuditViolationSchema).min(1),
  /** Schema version flow-through (H8). Phase 1 = 1. */
  auditSchemaVersion: z.literal(1),
  /** Correlation ID threaded from the request (H11). */
  correlationId: z.string().min(1),
  /**
   * Durable hoplon_audit_log row id when auditDiff successfully appends its
   * best-effort audit log record. Null when the log write failed; optional to
   * keep pre-existing mock/result fixtures source-compatible.
   */
  auditRef: z.string().min(1).nullable().optional(),
  /** hcr-005 derived-coverage evidence. Optional for transport compat. */
  coverage: AuditCoverageEvidenceSchema.optional(),
});

export const AuditResultSchema = z.discriminatedUnion('status', [
  AuditResultPassSchema,
  AuditResultBlockSchema,
]);

export type AuditResult = z.infer<typeof AuditResultSchema>;
