/**
 * Contract tests specifically for PackedContext shape.
 *
 * Proves:
 * - schema includes metadata + failures + slices
 * - PackFailure variants are validated
 * - zodToJsonSchema smoke
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  PackedContextSchema,
  PackFailureSchema,
} from '../../src/hoplon/contracts/context.js';

const VALID_METADATA = {
  strategyVersion: 1,
  grammarVersion: '0.20.8',
  packerVersion: 1,
  generatedAt: '2026-04-12T22:00:00.000Z',
  correlationId: 'corr-abc',
};

describe('PackedContext — structure', () => {
  it('has metadata, slices, and failures fields', () => {
    const result = PackedContextSchema.safeParse({
      metadata: VALID_METADATA,
      slices: [],
      failures: [],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect('metadata' in result.data).toBe(true);
      expect('slices' in result.data).toBe(true);
      expect('failures' in result.data).toBe(true);
    }
  });

  it('metadata.correlationId is mandatory', () => {
    const { correlationId: _c, ...withoutCorr } = VALID_METADATA;
    expect(
      PackedContextSchema.safeParse({ metadata: withoutCorr, slices: [], failures: [] }).success,
    ).toBe(false);
  });

  it('failures is explicitly always present (never suppressed)', () => {
    const result = PackedContextSchema.safeParse({
      metadata: VALID_METADATA,
      slices: [],
      // No failures field → should fail
    });
    expect(result.success).toBe(false);
  });
});

describe('PackFailure variants', () => {
  it('file_too_large requires sizeBytes and limitBytes', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/big.ts',
        reason: 'file_too_large',
        sizeBytes: 1000000,
        limitBytes: 524288,
      }).success,
    ).toBe(true);

    expect(
      PackFailureSchema.safeParse({
        path: 'src/big.ts',
        reason: 'file_too_large',
        // sizeBytes missing
        limitBytes: 524288,
      }).success,
    ).toBe(false);
  });

  it('parse_failure requires parseError', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/broken.ts',
        reason: 'parse_failure',
        parseError: 'syntax error at line 5',
      }).success,
    ).toBe(true);

    expect(
      PackFailureSchema.safeParse({
        path: 'src/broken.ts',
        reason: 'parse_failure',
        // parseError missing
      }).success,
    ).toBe(false);
  });

  it('parse_timeout requires timeoutMs', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/huge.ts',
        reason: 'parse_timeout',
        timeoutMs: 5000,
      }).success,
    ).toBe(true);
  });

  it('unsupported_extension requires extension', () => {
    expect(
      PackFailureSchema.safeParse({
        path: 'src/file.rb',
        reason: 'unsupported_extension',
        extension: '.rb',
      }).success,
    ).toBe(true);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema for PackedContext', () => {
    const jsonSchema = zodToJsonSchema(PackedContextSchema, 'PackedContext');
    expect(jsonSchema).toBeDefined();
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(100);
  });
});
