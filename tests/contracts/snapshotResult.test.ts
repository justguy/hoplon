/**
 * Contract tests for SnapshotResult and SnapshotWarning schemas.
 * (Split from snapshot.test.ts for clarity — this file focuses on the result shape.)
 */

import { describe, it, expect } from 'vitest';
import {
  SnapshotResultSchema,
  SnapshotWarningSchema,
} from '../../src/hoplon/contracts/snapshot.js';

const VALID_REF = {
  id: 'a'.repeat(64),
  engineId: 'local-0',
  runId: 'run-001',
  createdAt: '2026-04-12T22:00:00.000Z',
};

const VALID_WARNING = {
  kind: 'possible_secret' as const,
  path: 'src/config.ts',
  patternName: 'github_pat',
  lineNumber: 17,
  redactedSnippet: 'const token = "[REDACTED]"',
};

// ---------------------------------------------------------------------------
// SnapshotWarning
// ---------------------------------------------------------------------------

describe('SnapshotWarning — possible_secret', () => {
  it('accepts a valid warning', () => {
    expect(SnapshotWarningSchema.safeParse(VALID_WARNING).success).toBe(true);
  });

  it('rejects missing path', () => {
    const { path: _p, ...without } = VALID_WARNING;
    expect(SnapshotWarningSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing patternName', () => {
    const { patternName: _p, ...without } = VALID_WARNING;
    expect(SnapshotWarningSchema.safeParse(without).success).toBe(false);
  });

  it('rejects empty patternName', () => {
    expect(
      SnapshotWarningSchema.safeParse({ ...VALID_WARNING, patternName: '' }).success,
    ).toBe(false);
  });

  it('rejects missing lineNumber', () => {
    const { lineNumber: _l, ...without } = VALID_WARNING;
    expect(SnapshotWarningSchema.safeParse(without).success).toBe(false);
  });

  it('rejects negative lineNumber', () => {
    expect(
      SnapshotWarningSchema.safeParse({ ...VALID_WARNING, lineNumber: -1 }).success,
    ).toBe(false);
  });

  it('rejects missing redactedSnippet', () => {
    const { redactedSnippet: _r, ...without } = VALID_WARNING;
    expect(SnapshotWarningSchema.safeParse(without).success).toBe(false);
  });

  it('rejects unknown warning kind', () => {
    expect(
      SnapshotWarningSchema.safeParse({ ...VALID_WARNING, kind: 'leaked_credentials' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SnapshotResult
// ---------------------------------------------------------------------------

describe('SnapshotResult', () => {
  it('accepts result with valid ref and empty warnings', () => {
    expect(
      SnapshotResultSchema.safeParse({ snapshotRef: VALID_REF, warnings: [] }).success,
    ).toBe(true);
  });

  it('accepts result with valid warnings', () => {
    expect(
      SnapshotResultSchema.safeParse({
        snapshotRef: VALID_REF,
        warnings: [VALID_WARNING],
      }).success,
    ).toBe(true);
  });

  it('rejects missing snapshotRef', () => {
    expect(SnapshotResultSchema.safeParse({ warnings: [] }).success).toBe(false);
  });

  it('rejects missing warnings', () => {
    expect(SnapshotResultSchema.safeParse({ snapshotRef: VALID_REF }).success).toBe(false);
  });

  it('rejects invalid snapshotRef (missing runId)', () => {
    const { runId: _r, ...withoutRun } = VALID_REF;
    expect(
      SnapshotResultSchema.safeParse({ snapshotRef: withoutRun, warnings: [] }).success,
    ).toBe(false);
  });
});
