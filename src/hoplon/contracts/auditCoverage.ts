/** Derived audit-coverage evidence, split from audit.ts for the 300-line limit. */

import { z } from 'zod';

/** Why derived coverage fell back to declared+written files only (hcr-005). */
export const AUDIT_COVERAGE_PARTIAL_REASONS = [
  'fs_not_wired',
  'snapshot_store_not_wired',
  'snapshot_record_missing',
  'presence_evidence_missing',
  'discovery_failed',
] as const;

/**
 * Evidence of how the audited file set was derived. `declared_only` is an
 * explicit partial result, never a claim of complete workspace coverage.
 */
export const AuditCoverageEvidenceSchema = z.object({
  mode: z.enum(['derived', 'declared_only']),
  declaredFileCount: z.number().int().nonnegative(),
  /** Sorted paths only; content is never included. */
  discoveredPostSnapshotFiles: z.array(z.string()),
  partialReason: z.enum(AUDIT_COVERAGE_PARTIAL_REASONS).nullable(),
});

export type AuditCoverageEvidence = z.infer<typeof AuditCoverageEvidenceSchema>;
