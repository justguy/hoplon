/**
 * Contract tests for ReconcileReport schema.
 */

import { describe, it, expect } from 'vitest';
import { ReconcileReportSchema } from '../../src/hoplon/contracts/reconcile.js';

describe('ReconcileReport', () => {
  it('accepts a valid report', () => {
    const result = ReconcileReportSchema.safeParse({
      reconciled: 3,
      failed: 1,
      orphans: { gitObjects: 2, pendingRows: 4 },
    });
    expect(result.success).toBe(true);
  });

  it('accepts all-zero report (clean state)', () => {
    const result = ReconcileReportSchema.safeParse({
      reconciled: 0,
      failed: 0,
      orphans: { gitObjects: 0, pendingRows: 0 },
    });
    expect(result.success).toBe(true);
  });

  it('rejects negative reconciled', () => {
    expect(
      ReconcileReportSchema.safeParse({
        reconciled: -1,
        failed: 0,
        orphans: { gitObjects: 0, pendingRows: 0 },
      }).success,
    ).toBe(false);
  });

  it('rejects missing orphans', () => {
    expect(
      ReconcileReportSchema.safeParse({ reconciled: 0, failed: 0 }).success,
    ).toBe(false);
  });

  it('rejects missing orphans.pendingRows', () => {
    expect(
      ReconcileReportSchema.safeParse({
        reconciled: 0,
        failed: 0,
        orphans: { gitObjects: 0 },
      }).success,
    ).toBe(false);
  });

  it('rejects non-integer reconciled', () => {
    expect(
      ReconcileReportSchema.safeParse({
        reconciled: 1.5,
        failed: 0,
        orphans: { gitObjects: 0, pendingRows: 0 },
      }).success,
    ).toBe(false);
  });
});
