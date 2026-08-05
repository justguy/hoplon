/**
 * tests/parseOutput.test.ts — Unit tests for parseGitleaksOutput.
 *
 * These tests operate on raw JSON strings; no filesystem, no binary, no network.
 */

import { describe, it, expect } from 'vitest';
import { parseGitleaksOutput, ParseOutputError } from '../src/parseOutput.js';
import type { GitleaksFinding } from '@phalanx/hoplon';

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

/** Minimal valid finding matching the gitleaks v8 JSON schema. */
function makeFinding(overrides: Partial<{
  RuleID: string;
  StartLine: number;
  Line: string;
  Secret: string;
  [key: string]: unknown;
}> = {}): Record<string, unknown> {
  return {
    RuleID: 'aws-access-token',
    StartLine: 3,
    Line: 'const key = "AKIAIOSFODNN7EXAMPLE";',
    Secret: 'AKIAIOSFODNN7EXAMPLE',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('parseGitleaksOutput', () => {
  // -------------------------------------------------------------------------
  // Empty / no-finding cases
  // -------------------------------------------------------------------------

  it('returns empty array for empty string (no findings)', () => {
    expect(parseGitleaksOutput('')).toEqual([]);
  });

  it('returns empty array for whitespace-only output', () => {
    expect(parseGitleaksOutput('   \n  ')).toEqual([]);
  });

  it('returns empty array for JSON empty array', () => {
    expect(parseGitleaksOutput('[]')).toEqual([]);
  });

  it('returns empty array for JSON null', () => {
    expect(parseGitleaksOutput('null')).toEqual([]);
  });

  // -------------------------------------------------------------------------
  // Single valid finding
  // -------------------------------------------------------------------------

  it('parses a single valid finding into GitleaksFinding', () => {
    const raw = JSON.stringify([makeFinding()]);
    const result = parseGitleaksOutput(raw);
    expect(result).toHaveLength(1);
    const finding = result[0] as GitleaksFinding;
    expect(finding.ruleId).toBe('aws-access-token');
    expect(finding.lineNumber).toBe(3);
    expect(finding.line).toBe('const key = "AKIAIOSFODNN7EXAMPLE";');
    expect(finding.secret).toBe('AKIAIOSFODNN7EXAMPLE');
  });

  it('ignores unknown extra fields in the finding object', () => {
    const raw = JSON.stringify([
      makeFinding({ ExtraField: 'ignored', AnotherField: 42 }),
    ]);
    const result = parseGitleaksOutput(raw);
    expect(result).toHaveLength(1);
    // Only the four known fields should be present in the mapped output
    const finding = result[0] as GitleaksFinding;
    expect(Object.keys(finding)).toEqual(
      expect.arrayContaining(['ruleId', 'lineNumber', 'line', 'secret']),
    );
    expect('ExtraField' in finding).toBe(false);
  });

  // -------------------------------------------------------------------------
  // Multiple findings + sort order
  // -------------------------------------------------------------------------

  it('parses multiple findings and sorts by lineNumber ascending', () => {
    const raw = JSON.stringify([
      makeFinding({ RuleID: 'github-pat', StartLine: 10, Line: 'line 10', Secret: 'ghp_token' }),
      makeFinding({ RuleID: 'aws-access-token', StartLine: 3, Line: 'line 3', Secret: 'AKIAxxx' }),
      makeFinding({ RuleID: 'private-key', StartLine: 7, Line: 'line 7', Secret: '-----BEGIN' }),
    ]);
    const result = parseGitleaksOutput(raw);
    expect(result).toHaveLength(3);
    expect(result[0]?.lineNumber).toBe(3);
    expect(result[1]?.lineNumber).toBe(7);
    expect(result[2]?.lineNumber).toBe(10);
  });

  it('sorts findings with equal lineNumber by ruleId ascending', () => {
    const raw = JSON.stringify([
      makeFinding({ RuleID: 'z-rule', StartLine: 5, Line: 'line 5', Secret: 'z_secret' }),
      makeFinding({ RuleID: 'a-rule', StartLine: 5, Line: 'line 5', Secret: 'a_secret' }),
      makeFinding({ RuleID: 'm-rule', StartLine: 5, Line: 'line 5', Secret: 'm_secret' }),
    ]);
    const result = parseGitleaksOutput(raw);
    expect(result).toHaveLength(3);
    expect(result[0]?.ruleId).toBe('a-rule');
    expect(result[1]?.ruleId).toBe('m-rule');
    expect(result[2]?.ruleId).toBe('z-rule');
  });

  // -------------------------------------------------------------------------
  // Unknown / pass-through rule ID
  // -------------------------------------------------------------------------

  it('passes through unknown rule IDs without modification', () => {
    const raw = JSON.stringify([
      makeFinding({ RuleID: 'totally-unknown-rule-xyz-12345', StartLine: 1, Line: 'x', Secret: 'y' }),
    ]);
    const result = parseGitleaksOutput(raw);
    expect(result).toHaveLength(1);
    expect(result[0]?.ruleId).toBe('totally-unknown-rule-xyz-12345');
  });

  // -------------------------------------------------------------------------
  // Malformed JSON → ParseOutputError
  // -------------------------------------------------------------------------

  it('throws ParseOutputError for malformed JSON', () => {
    expect(() => parseGitleaksOutput('{invalid json')).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError with rawOutput field set on malformed JSON', () => {
    const bad = '{not json at all';
    try {
      parseGitleaksOutput(bad);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseOutputError);
      expect((err as ParseOutputError).rawOutput).toBe(bad);
    }
  });

  it('throws ParseOutputError when top-level JSON value is not an array (object)', () => {
    const raw = JSON.stringify({ RuleID: 'aws-access-token' });
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when top-level JSON value is a number', () => {
    expect(() => parseGitleaksOutput('42')).toThrow(ParseOutputError);
  });

  // -------------------------------------------------------------------------
  // Missing required fields → ParseOutputError
  // -------------------------------------------------------------------------

  it('throws ParseOutputError when finding is missing RuleID', () => {
    const raw = JSON.stringify([{ StartLine: 1, Line: 'x', Secret: 'y' }]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when finding is missing StartLine', () => {
    const raw = JSON.stringify([{ RuleID: 'test', Line: 'x', Secret: 'y' }]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when finding is missing Line', () => {
    const raw = JSON.stringify([{ RuleID: 'test', StartLine: 1, Secret: 'y' }]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when finding is missing Secret', () => {
    const raw = JSON.stringify([{ RuleID: 'test', StartLine: 1, Line: 'x' }]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when StartLine is not a positive integer', () => {
    const raw = JSON.stringify([makeFinding({ StartLine: 0 })]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when StartLine is a float', () => {
    const raw = JSON.stringify([makeFinding({ StartLine: 1.5 })]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when finding array element is not an object', () => {
    const raw = JSON.stringify(['not-an-object']);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });

  it('throws ParseOutputError when RuleID is an empty string', () => {
    const raw = JSON.stringify([makeFinding({ RuleID: '' })]);
    expect(() => parseGitleaksOutput(raw)).toThrow(ParseOutputError);
  });
});
