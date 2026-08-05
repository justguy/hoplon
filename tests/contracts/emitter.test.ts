/**
 * Contract tests for HoplonEvent schema.
 *
 * Critical proof: HoplonEventSchema uses .strict() (H13).
 * Any event containing content fields (symbol names, paths, AST values, etc.)
 * must be rejected at parse time.
 */

import { describe, it, expect } from 'vitest';
import { HoplonEventSchema } from '../../src/hoplon/adapters/emitter.js';

const VALID_EVENT = {
  op: 'createSnapshot' as const,
  phase: 'start' as const,
  engineId: 'local-0',
  correlationId: 'corr-abc-123',
};

// ---------------------------------------------------------------------------
// Valid events
// ---------------------------------------------------------------------------

describe('HoplonEvent — valid shapes', () => {
  it('accepts minimal start event', () => {
    expect(HoplonEventSchema.safeParse(VALID_EVENT).success).toBe(true);
  });

  it('accepts end event with durationMs and classification', () => {
    expect(
      HoplonEventSchema.safeParse({
        ...VALID_EVENT,
        phase: 'end',
        durationMs: 142,
        classification: 'PASS',
      }).success,
    ).toBe(true);
  });

  it('accepts error event with errorCategory and errorKind', () => {
    expect(
      HoplonEventSchema.safeParse({
        ...VALID_EVENT,
        phase: 'error',
        durationMs: 50,
        classification: 'ERROR',
        errorCategory: 'adapter',
        errorKind: 'fs_read_failed',
      }).success,
    ).toBe(true);
  });

  it('accepts event with optional projectId and runId', () => {
    expect(
      HoplonEventSchema.safeParse({
        ...VALID_EVENT,
        projectId: 'my-project',
        runId: 'run-001',
      }).success,
    ).toBe(true);
  });

  it('accepts all valid op values', () => {
    const ops = [
      'createSnapshot',
      'auditDiff',
      'revertUncontracted',
      'packContext',
      'health',
      'reconcile',
    ] as const;
    for (const op of ops) {
      expect(HoplonEventSchema.safeParse({ ...VALID_EVENT, op }).success).toBe(true);
    }
  });

  it('accepts all valid phase values', () => {
    const phases = ['start', 'end', 'error'] as const;
    for (const phase of phases) {
      expect(HoplonEventSchema.safeParse({ ...VALID_EVENT, phase }).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// Invalid events
// ---------------------------------------------------------------------------

describe('HoplonEvent — invalid shapes', () => {
  it('rejects missing engineId', () => {
    const { engineId: _e, ...without } = VALID_EVENT;
    expect(HoplonEventSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing correlationId', () => {
    const { correlationId: _c, ...without } = VALID_EVENT;
    expect(HoplonEventSchema.safeParse(without).success).toBe(false);
  });

  it('rejects unknown op', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, op: 'unknownOp' }).success,
    ).toBe(false);
  });

  it('rejects unknown phase', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, phase: 'warning' }).success,
    ).toBe(false);
  });

  it('rejects negative durationMs', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, durationMs: -1 }).success,
    ).toBe(false);
  });

  it('rejects unknown errorCategory', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, errorCategory: 'network' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// H13 proof: .strict() rejects content fields
// ---------------------------------------------------------------------------

describe('HoplonEvent — H13 content-free enforcement (.strict())', () => {
  it('rejects extra field symbolName (H13 proof)', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, symbolName: 'formatPrice' }).success,
    ).toBe(false);
  });

  it('rejects extra field filePath (H13 proof)', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, filePath: 'src/auth.ts' }).success,
    ).toBe(false);
  });

  it('rejects extra field sourceSlice (H13 proof)', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, sourceSlice: 'const x = 1;' }).success,
    ).toBe(false);
  });

  it('rejects extra field astNodeValue (H13 proof)', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, astNodeValue: 'some_value' }).success,
    ).toBe(false);
  });

  it('rejects any arbitrary unknown field (H13 generalized proof)', () => {
    expect(
      HoplonEventSchema.safeParse({ ...VALID_EVENT, content: 'secret code here' }).success,
    ).toBe(false);
  });
});
