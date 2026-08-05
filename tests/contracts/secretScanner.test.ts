/**
 * Contract tests for SecretFinding schema.
 */

import { describe, it, expect } from 'vitest';
import { SecretFindingSchema } from '../../src/hoplon/adapters/secretScanner.js';

const VALID_FINDING = {
  patternName: 'aws_access_key',
  lineNumber: 42,
  redactedSnippet: 'const key = "[REDACTED]"',
};

describe('SecretFinding', () => {
  it('accepts a valid finding', () => {
    expect(SecretFindingSchema.safeParse(VALID_FINDING).success).toBe(true);
  });

  it('accepts empty redactedSnippet', () => {
    expect(
      SecretFindingSchema.safeParse({ ...VALID_FINDING, redactedSnippet: '' }).success,
    ).toBe(true);
  });

  it('rejects missing patternName', () => {
    const { patternName: _p, ...without } = VALID_FINDING;
    expect(SecretFindingSchema.safeParse(without).success).toBe(false);
  });

  it('rejects empty patternName', () => {
    expect(
      SecretFindingSchema.safeParse({ ...VALID_FINDING, patternName: '' }).success,
    ).toBe(false);
  });

  it('rejects missing lineNumber', () => {
    const { lineNumber: _l, ...without } = VALID_FINDING;
    expect(SecretFindingSchema.safeParse(without).success).toBe(false);
  });

  it('rejects zero lineNumber (must be positive — 1-indexed)', () => {
    expect(
      SecretFindingSchema.safeParse({ ...VALID_FINDING, lineNumber: 0 }).success,
    ).toBe(false);
  });

  it('rejects negative lineNumber', () => {
    expect(
      SecretFindingSchema.safeParse({ ...VALID_FINDING, lineNumber: -5 }).success,
    ).toBe(false);
  });

  it('rejects non-integer lineNumber', () => {
    expect(
      SecretFindingSchema.safeParse({ ...VALID_FINDING, lineNumber: 1.5 }).success,
    ).toBe(false);
  });

  it('rejects missing redactedSnippet', () => {
    const { redactedSnippet: _r, ...without } = VALID_FINDING;
    expect(SecretFindingSchema.safeParse(without).success).toBe(false);
  });
});
