/**
 * Contract tests specifically for AuditResult schema versions (H8 proof).
 *
 * Proves:
 * - Both PASS and BLOCK carry auditSchemaVersion: 1 and correlationId
 * - Both variants optionally accept nullable auditRef
 * - auditSchemaVersion: 2 is rejected (no future-version acceptance)
 * - correlationId is mandatory on both variants
 */

import { describe, it, expect } from 'vitest';
import { AuditResultSchema } from '../../src/hoplon/contracts/audit.js';

const VALID_VIOLATION = {
  kind: 'snapshot_missing' as const,
  path: 'src/auth.ts',
  snapshotRefId: 'a'.repeat(64),
  message: 'Snapshot not found.',
  correction: 'Re-run createSnapshot.',
};

describe('AuditResult — H8 schema version flow-through', () => {
  it('PASS accepts auditSchemaVersion: 1 and correlationId', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 5,
        auditSchemaVersion: 1,
        correlationId: 'corr-test-123',
        auditRef: 'audit-pass-123',
      }).success,
    ).toBe(true);
  });

  it('PASS rejects auditSchemaVersion: 2', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 5,
        auditSchemaVersion: 2,
        correlationId: 'corr-test-123',
      }).success,
    ).toBe(false);
  });

  it('BLOCK accepts auditSchemaVersion: 1 and correlationId', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'BLOCK',
        violations: [VALID_VIOLATION],
        auditSchemaVersion: 1,
        correlationId: 'corr-test-456',
        auditRef: null,
      }).success,
    ).toBe(true);
  });

  it('BLOCK rejects auditSchemaVersion: 2', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'BLOCK',
        violations: [VALID_VIOLATION],
        auditSchemaVersion: 2,
        correlationId: 'corr-test-456',
      }).success,
    ).toBe(false);
  });

  it('PASS rejects empty correlationId', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 1,
        auditSchemaVersion: 1,
        correlationId: '',
      }).success,
    ).toBe(false);
  });

  it('BLOCK rejects missing correlationId', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'BLOCK',
        violations: [VALID_VIOLATION],
        auditSchemaVersion: 1,
      }).success,
    ).toBe(false);
  });
});
