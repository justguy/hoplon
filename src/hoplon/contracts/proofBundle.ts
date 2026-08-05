/**
 * contracts/proofBundle.ts — ProofBundle durable record (t-068).
 *
 * A ProofBundle is the raw-truth layer of the trace foundation. It holds
 * the authoritative Hoplon proof for one Attempt, including the full raw
 * AuditResult (PASS or BLOCK with violation evidence such as path,
 * nodeKind, byteRange, sourceSlice, expectedScope, correction).
 *
 * This record is EXPLICITLY NOT H13-safe. The H13-safe `hoplon_audit_log`
 * stores kinds/counts/timings only and remains unchanged. The ProofBundle
 * is the explicit raw-proof surface the viewer spec requires ("raw truth
 * first"); it is marked authoritative-Hoplon and must never be merged with
 * derived wrapper metadata or higher-order-agent summaries.
 *
 * Violations are also indexed as separate ProofViolation records by the
 * TraceStore adapter for search-by-path / search-by-violation-id; the raw
 * copy kept inside the ProofBundle is the canonical one.
 */

import { z } from 'zod';
import { AuditResultSchema } from './audit.js';

export const ProofBundleSchema = z.object({
  /** Stable proof bundle ref. */
  proofBundleRef: z.string().min(1),
  /** The attempt this proof belongs to. */
  attemptId: z.string().min(1),
  /** Parent execution, denormalised for cheap lookup. */
  executionId: z.string().min(1),
  /** Project + run scoping for search. */
  projectId: z.string().min(1),
  runId: z.string().min(1),
  /** Snapshot refs. */
  snapshotRefBefore: z.string().min(1),
  snapshotRefAfter: z.string().min(1).nullable(),
  /** Opaque stable ref back to the AuditLogRecord uuid. */
  auditRef: z.string().min(1).nullable(),
  /** Durable, per-violation ids for search / direct retrieval. */
  violationRefs: z.array(z.string().min(1)),
  /** Optional manifest ref (hash or id). */
  manifestRef: z.string().min(1).nullable(),
  /** Engine + schema versions for compatibility. */
  engineVersion: z.string().min(1),
  engineId: z.string().min(1),
  schemaVersion: z.number().int().positive(),
  correlationId: z.string().min(1),
  /**
   * The raw authoritative Hoplon AuditResult. Not summarised, not
   * collapsed to kind-only. Consumers that need low-cost summaries should
   * read Attempt.status and the denormalised violation index instead.
   */
  auditResult: AuditResultSchema,
  /** ISO 8601 UTC. */
  createdAt: z.string(),
});

export type ProofBundle = z.infer<typeof ProofBundleSchema>;

/**
 * Per-violation index record. The canonical copy of the violation lives
 * inside ProofBundle.auditResult; this record is the search/index row
 * persisted alongside it.
 */
export const ProofViolationSchema = z.object({
  violationId: z.string().min(1),
  proofBundleRef: z.string().min(1),
  attemptId: z.string().min(1),
  executionId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  /** Closed-union kind string from AuditViolation.kind. */
  kind: z.string().min(1),
  /** Path if present on the underlying violation, null otherwise. */
  path: z.string().min(1).nullable(),
  /** Symbol name if present on the underlying violation. */
  symbolName: z.string().min(1).nullable(),
  /** Tree-sitter node kind if present. */
  nodeKind: z.string().min(1).nullable(),
  /** Optional byte range [start, end]. */
  byteRangeStart: z.number().int().nonnegative().nullable(),
  byteRangeEnd: z.number().int().nonnegative().nullable(),
  /** Opaque index for round-tripping back into the parent proof. */
  indexInBundle: z.number().int().nonnegative(),
  createdAt: z.string(),
});

export type ProofViolation = z.infer<typeof ProofViolationSchema>;
