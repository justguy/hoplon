/**
 * Contract tests for RevertResult schema.
 *
 * A3.1 update: RevertResult now has reverted, deleted, allowlistSkipped
 * (was reverted, skipped — breaking change per RS-1 semantics).
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import { RevertResultSchema } from '../../src/hoplon/contracts/revert.js';

describe('RevertResult', () => {
  it('accepts valid result with all three arrays', () => {
    const result = RevertResultSchema.safeParse({
      reverted: ['src/util/format.ts'],
      deleted: ['src/tmp/scratch.ts'],
      allowlistSkipped: ['.git/config'],
    });
    expect(result.success).toBe(true);
  });

  it('accepts all empty arrays', () => {
    expect(
      RevertResultSchema.safeParse({ reverted: [], deleted: [], allowlistSkipped: [] }).success,
    ).toBe(true);
  });

  it('rejects missing reverted', () => {
    expect(
      RevertResultSchema.safeParse({ deleted: [], allowlistSkipped: [] }).success,
    ).toBe(false);
  });

  it('rejects missing deleted', () => {
    expect(
      RevertResultSchema.safeParse({ reverted: [], allowlistSkipped: [] }).success,
    ).toBe(false);
  });

  it('rejects missing allowlistSkipped', () => {
    expect(
      RevertResultSchema.safeParse({ reverted: [], deleted: [] }).success,
    ).toBe(false);
  });

  it('rejects non-string paths in reverted', () => {
    expect(
      RevertResultSchema.safeParse({ reverted: [42], deleted: [], allowlistSkipped: [] }).success,
    ).toBe(false);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(RevertResultSchema, 'RevertResult');
    expect(jsonSchema).toBeDefined();
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(30);
  });
});
