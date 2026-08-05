/**
 * reconcile.ts — ReconcileReport Zod schema and inferred type.
 *
 * Returned by engine.reconcile() after detecting and resolving orphaned
 * snapshot records (H10 atomicity recovery).
 */

import { z } from 'zod';

export const ReconcileReportSchema = z.object({
  /** Number of orphaned pending records that were successfully reconciled. */
  reconciled: z.number().int().nonnegative(),
  /** Number of records that failed reconciliation (left in 'failed' status). */
  failed: z.number().int().nonnegative(),
  orphans: z.object({
    /** Orphaned git objects detected in the git object store. */
    gitObjects: z.number().int().nonnegative(),
    /** Orphaned pending rows in the snapshot registry. */
    pendingRows: z.number().int().nonnegative(),
  }),
});

export type ReconcileReport = z.infer<typeof ReconcileReportSchema>;
