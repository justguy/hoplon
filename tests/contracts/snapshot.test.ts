/**
 * Contract tests for SnapshotRef, SnapshotResult, and SnapshotWarning schemas.
 *
 * A3.1 updates:
 * - SnapshotRef now has runId field
 * - SnapshotResult schema added (bundles ref + warnings)
 * - SnapshotWarning discriminated union added
 *
 * HA1 updates:
 * - SnapshotRef.id now accepts both `sha256:<64-hex>` (new) and bare 64-hex (legacy, H19).
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  SnapshotRefSchema,
  SnapshotResultSchema,
  SnapshotWarningSchema,
} from '../../src/hoplon/contracts/snapshot.js';

// Phase 2 HA1: new format is sha256:<64-hex>
const VALID_SNAPSHOT_REF = {
  id: `sha256:${'a'.repeat(64)}`, // new HA1 prefixed format
  engineId: 'local-0',
  runId: 'run-abc-123',
  createdAt: '2026-04-12T22:00:00.000Z',
};

// Legacy bare-hex ref (still valid — H19 backward compat)
const LEGACY_SNAPSHOT_REF = {
  id: 'a'.repeat(64), // Phase 1 bare 64-char hex
  engineId: 'local-0',
  runId: 'run-abc-123',
  createdAt: '2026-04-12T22:00:00.000Z',
};

// ---------------------------------------------------------------------------
// SnapshotRef
// ---------------------------------------------------------------------------

describe('SnapshotRef', () => {
  it('accepts a valid snapshot ref with new sha256: prefixed ID (HA1)', () => {
    const result = SnapshotRefSchema.safeParse(VALID_SNAPSHOT_REF);
    expect(result.success).toBe(true);
  });

  it('accepts a legacy bare-hex ID for backward compat (H19)', () => {
    const result = SnapshotRefSchema.safeParse(LEGACY_SNAPSHOT_REF);
    expect(result.success).toBe(true);
  });

  it('rejects id shorter than 64 chars (bare form)', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      id: 'abc123',
    });
    expect(result.success).toBe(false);
  });

  it('rejects bare id longer than 64 chars', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      id: 'a'.repeat(65),
    });
    expect(result.success).toBe(false);
  });

  it('rejects prefixed id with wrong algorithm name', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      id: `md5:${'a'.repeat(64)}`,
    });
    expect(result.success).toBe(false);
  });

  it('rejects id with uppercase hex', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      id: 'A'.repeat(64),
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty engineId', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      engineId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects engineId with whitespace', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      engineId: 'local 0',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing runId', () => {
    const { runId: _r, ...without } = VALID_SNAPSHOT_REF;
    expect(SnapshotRefSchema.safeParse(without).success).toBe(false);
  });

  it('rejects empty runId', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      runId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects non-ISO createdAt', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      createdAt: '2026-04-12',
    });
    expect(result.success).toBe(false);
  });

  it('rejects createdAt with timezone offset (must be UTC Z)', () => {
    const result = SnapshotRefSchema.safeParse({
      ...VALID_SNAPSHOT_REF,
      createdAt: '2026-04-12T22:00:00.000+05:00',
    });
    expect(result.success).toBe(false);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(SnapshotRefSchema, 'SnapshotRef');
    expect(jsonSchema).toBeDefined();
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(50);
  });
});

// ---------------------------------------------------------------------------
// SnapshotWarning
// ---------------------------------------------------------------------------

const VALID_WARNING = {
  kind: 'possible_secret' as const,
  path: 'src/config.ts',
  patternName: 'aws_access_key',
  lineNumber: 42,
  redactedSnippet: 'const KEY = "[REDACTED]"',
};

describe('SnapshotWarning', () => {
  it('accepts a valid possible_secret warning', () => {
    expect(SnapshotWarningSchema.safeParse(VALID_WARNING).success).toBe(true);
  });

  it('rejects missing patternName', () => {
    const { patternName: _p, ...without } = VALID_WARNING;
    expect(SnapshotWarningSchema.safeParse(without).success).toBe(false);
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

  it('rejects unknown kind', () => {
    expect(
      SnapshotWarningSchema.safeParse({ ...VALID_WARNING, kind: 'unknown_thing' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SnapshotResult
// ---------------------------------------------------------------------------

describe('SnapshotResult', () => {
  it('accepts a valid result with non-empty warnings', () => {
    const result = SnapshotResultSchema.safeParse({
      snapshotRef: VALID_SNAPSHOT_REF,
      warnings: [VALID_WARNING],
    });
    expect(result.success).toBe(true);
  });

  it('accepts a valid result with empty warnings array', () => {
    const result = SnapshotResultSchema.safeParse({
      snapshotRef: VALID_SNAPSHOT_REF,
      warnings: [],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing warnings array', () => {
    const result = SnapshotResultSchema.safeParse({
      snapshotRef: VALID_SNAPSHOT_REF,
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing snapshotRef', () => {
    expect(SnapshotResultSchema.safeParse({ warnings: [] }).success).toBe(false);
  });
});
