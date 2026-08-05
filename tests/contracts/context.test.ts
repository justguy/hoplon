/**
 * Contract tests for PackedContext, PackedSlice, and PackFailure schemas.
 *
 * A3.1 updates:
 * - PackedContext now has metadata, slices, and failures fields
 * - PackFailure discriminated union with 4 variants
 * - Old parseFailure field on PackedSlice removed
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  PackedSliceSchema,
  PackFailureSchema,
  PackedContextSchema,
} from '../../src/hoplon/contracts/context.js';

const VALID_SLICE = {
  path: 'src/util/format.ts',
  byteRange: [0, 128] as [number, number],
  nodeKinds: ['function_declaration'],
  content: 'function formatPrice(n: number): string { return `$${n}`; }',
};

const VALID_METADATA = {
  strategyVersion: 1,
  grammarVersion: '0.20.8',
  packerVersion: 1,
  generatedAt: '2026-04-12T22:00:00.000Z',
  correlationId: 'corr-abc-123',
};

// ---------------------------------------------------------------------------
// PackedSlice
// ---------------------------------------------------------------------------

describe('PackedSlice', () => {
  it('accepts a valid slice', () => {
    expect(PackedSliceSchema.safeParse(VALID_SLICE).success).toBe(true);
  });

  it('rejects empty path', () => {
    expect(PackedSliceSchema.safeParse({ ...VALID_SLICE, path: '' }).success).toBe(false);
  });

  it('rejects negative byteRange start', () => {
    expect(
      PackedSliceSchema.safeParse({ ...VALID_SLICE, byteRange: [-1, 128] }).success,
    ).toBe(false);
  });

  it('rejects byteRange with non-integer', () => {
    expect(
      PackedSliceSchema.safeParse({ ...VALID_SLICE, byteRange: [0.5, 128] }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PackFailure
// ---------------------------------------------------------------------------

describe('PackFailure', () => {
  it('accepts file_too_large variant', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/big.ts',
        reason: 'file_too_large',
        sizeBytes: 1048576,
        limitBytes: 524288,
      }).success,
    ).toBe(true);
  });

  it('accepts parse_failure variant', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/broken.ts',
        reason: 'parse_failure',
        parseError: 'Unexpected token at line 5',
      }).success,
    ).toBe(true);
  });

  it('accepts parse_timeout variant', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/huge.ts',
        reason: 'parse_timeout',
        timeoutMs: 5000,
      }).success,
    ).toBe(true);
  });

  it('accepts unsupported_extension variant', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/file.rb',
        reason: 'unsupported_extension',
        extension: '.rb',
      }).success,
    ).toBe(true);
  });

  it('rejects unknown reason', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/file.ts',
        reason: 'unknown_reason',
      }).success,
    ).toBe(false);
  });

  it('rejects file_too_large without sizeBytes', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/big.ts',
        reason: 'file_too_large',
        limitBytes: 524288,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// PackedContext
// ---------------------------------------------------------------------------

describe('PackedContext', () => {
  it('accepts valid context with metadata, slices, and failures', () => {
    const result = PackedContextSchema.safeParse({
      metadata: VALID_METADATA,
      slices: [VALID_SLICE],
      failures: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts context with empty slices and failures', () => {
    const result = PackedContextSchema.safeParse({
      metadata: VALID_METADATA,
      slices: [],
      failures: [],
    });
    expect(result.success).toBe(true);
  });

  it('accepts context with failures', () => {
    const result = PackedContextSchema.safeParse({
      metadata: VALID_METADATA,
      slices: [],
      failures: [
        { path: 'src/big.ts', reason: 'file_too_large', sizeBytes: 1000000, limitBytes: 524288 },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('rejects missing metadata', () => {
    expect(
      PackedContextSchema.safeParse({ slices: [], failures: [] }).success,
    ).toBe(false);
  });

  it('rejects missing slices field', () => {
    expect(
      PackedContextSchema.safeParse({ metadata: VALID_METADATA, failures: [] }).success,
    ).toBe(false);
  });

  it('rejects missing failures field', () => {
    expect(
      PackedContextSchema.safeParse({ metadata: VALID_METADATA, slices: [] }).success,
    ).toBe(false);
  });

  it('rejects metadata missing correlationId', () => {
    const { correlationId: _c, ...withoutCorrelationId } = VALID_METADATA;
    expect(
      PackedContextSchema.safeParse({
        metadata: withoutCorrelationId,
        slices: [],
        failures: [],
      }).success,
    ).toBe(false);
  });

  it('rejects metadata with non-UTC generatedAt', () => {
    expect(
      PackedContextSchema.safeParse({
        metadata: { ...VALID_METADATA, generatedAt: '2026-04-12' },
        slices: [],
        failures: [],
      }).success,
    ).toBe(false);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(PackedContextSchema, 'PackedContext');
    expect(jsonSchema).toBeDefined();
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(50);
  });
});
