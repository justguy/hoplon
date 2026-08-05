/**
 * tests/parseOutput.test.ts — unit tests for semgrep output parsing.
 *
 * All tests use stubbed/hardcoded output — no subprocess, no semgrep binary required.
 * Part of @phalanx/hoplon-static-analysis-semgrep (LGPL-2.1-or-later).
 */

import { describe, it, expect } from 'vitest';
import {
  parseSemgrepOutput,
  ParseSemgrepOutputError,
  mapSeverity,
  extractSemgrepErrors,
} from '../src/parseOutput.js';

// ---------------------------------------------------------------------------
// Helpers — build minimal valid semgrep JSON
// ---------------------------------------------------------------------------

function makeResult(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    check_id: 'test.rule',
    path: 'src/foo.ts',
    extra: {
      message: 'Test message',
      severity: 'WARNING',
    },
    start: { line: 1, col: 1, offset: 0 },
    end: { line: 1, col: 10, offset: 9 },
    ...overrides,
  };
}

function makeOutput(
  results: Record<string, unknown>[] = [],
  errors: Record<string, unknown>[] = [],
): string {
  return JSON.stringify({ results, errors });
}

// ---------------------------------------------------------------------------
// mapSeverity
// ---------------------------------------------------------------------------

describe('mapSeverity', () => {
  it('maps "ERROR" to "error"', () => {
    expect(mapSeverity('ERROR')).toBe('error');
  });

  it('maps "error" (lowercase) to "error"', () => {
    expect(mapSeverity('error')).toBe('error');
  });

  it('maps "WARNING" to "warning"', () => {
    expect(mapSeverity('WARNING')).toBe('warning');
  });

  it('maps "INFO" to "info"', () => {
    expect(mapSeverity('INFO')).toBe('info');
  });

  it('maps unknown string to "warning"', () => {
    expect(mapSeverity('NOTICE')).toBe('warning');
  });

  it('maps undefined to "warning"', () => {
    expect(mapSeverity(undefined)).toBe('warning');
  });

  it('maps null to "warning"', () => {
    expect(mapSeverity(null)).toBe('warning');
  });

  it('maps number to "warning"', () => {
    expect(mapSeverity(42)).toBe('warning');
  });
});

// ---------------------------------------------------------------------------
// parseSemgrepOutput — valid inputs
// ---------------------------------------------------------------------------

describe('parseSemgrepOutput — valid inputs', () => {
  it('returns empty array for clean run (no results)', () => {
    const findings = parseSemgrepOutput(makeOutput());
    expect(findings).toEqual([]);
  });

  it('parses a single WARNING finding correctly', () => {
    const raw = makeOutput([makeResult()]);
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(1);
    const f = findings[0]!;
    expect(f.path).toBe('src/foo.ts');
    expect(f.rule).toBe('test.rule');
    expect(f.message).toBe('Test message');
    expect(f.severity).toBe('warning');
  });

  it('parses a single ERROR finding correctly', () => {
    const raw = makeOutput([
      makeResult({ extra: { message: 'SQL injection risk', severity: 'ERROR' } }),
    ]);
    const findings = parseSemgrepOutput(raw);
    expect(findings[0]!.severity).toBe('error');
    expect(findings[0]!.message).toBe('SQL injection risk');
  });

  it('parses a single INFO finding correctly', () => {
    const raw = makeOutput([
      makeResult({ extra: { message: 'Informational', severity: 'INFO' } }),
    ]);
    const findings = parseSemgrepOutput(raw);
    expect(findings[0]!.severity).toBe('info');
  });

  it('parses multiple findings preserving order', () => {
    const raw = makeOutput([
      makeResult({ path: 'a.ts', check_id: 'rule.a' }),
      makeResult({ path: 'b.ts', check_id: 'rule.b' }),
      makeResult({ path: 'c.ts', check_id: 'rule.c' }),
    ]);
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(3);
    expect(findings[0]!.path).toBe('a.ts');
    expect(findings[1]!.path).toBe('b.ts');
    expect(findings[2]!.path).toBe('c.ts');
  });

  it('handles missing check_id by using "unknown-rule"', () => {
    const raw = makeOutput([makeResult({ check_id: undefined })]);
    const findings = parseSemgrepOutput(raw);
    expect(findings[0]!.rule).toBe('unknown-rule');
  });

  it('handles missing path by using empty string', () => {
    const raw = makeOutput([makeResult({ path: undefined })]);
    const findings = parseSemgrepOutput(raw);
    expect(findings[0]!.path).toBe('');
  });

  it('handles missing extra.message by using empty string', () => {
    const raw = makeOutput([makeResult({ extra: { severity: 'WARNING' } })]);
    const findings = parseSemgrepOutput(raw);
    expect(findings[0]!.message).toBe('');
  });

  it('handles missing extra by using empty string and warning severity', () => {
    const raw = makeOutput([makeResult({ extra: undefined })]);
    const findings = parseSemgrepOutput(raw);
    const f = findings[0]!;
    expect(f.message).toBe('');
    expect(f.severity).toBe('warning');
  });

  it('ignores the errors array (does not throw)', () => {
    const raw = makeOutput([], [{ code: 3, level: 'error', message: 'Some semgrep error', type: 'SemgrepError' }]);
    // errors present but results empty — should succeed with no findings
    expect(() => parseSemgrepOutput(raw)).not.toThrow();
    expect(parseSemgrepOutput(raw)).toHaveLength(0);
  });

  it('parses output where results array is present but null items are skipped gracefully', () => {
    // Null items in the results array — path/rule/message/severity all fall to defaults
    const raw = JSON.stringify({ results: [null], errors: [] });
    const findings = parseSemgrepOutput(raw);
    expect(findings).toHaveLength(1);
    expect(findings[0]!.path).toBe('');
    expect(findings[0]!.rule).toBe('unknown-rule');
  });
});

// ---------------------------------------------------------------------------
// parseSemgrepOutput — invalid inputs
// ---------------------------------------------------------------------------

describe('parseSemgrepOutput — invalid inputs', () => {
  it('throws ParseSemgrepOutputError on non-JSON input', () => {
    expect(() => parseSemgrepOutput('not json')).toThrow(ParseSemgrepOutputError);
  });

  it('throws ParseSemgrepOutputError when results field is missing', () => {
    expect(() => parseSemgrepOutput(JSON.stringify({ errors: [] }))).toThrow(
      ParseSemgrepOutputError,
    );
  });

  it('throws ParseSemgrepOutputError when results is not an array', () => {
    expect(() => parseSemgrepOutput(JSON.stringify({ results: 'bad', errors: [] }))).toThrow(
      ParseSemgrepOutputError,
    );
  });

  it('ParseSemgrepOutputError carries rawOutput', () => {
    const bad = 'definitely not json';
    try {
      parseSemgrepOutput(bad);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ParseSemgrepOutputError);
      expect((err as ParseSemgrepOutputError).rawOutput).toBe(bad);
    }
  });

  it('throws ParseSemgrepOutputError on empty string', () => {
    expect(() => parseSemgrepOutput('')).toThrow(ParseSemgrepOutputError);
  });
});

// ---------------------------------------------------------------------------
// extractSemgrepErrors
// ---------------------------------------------------------------------------

describe('extractSemgrepErrors', () => {
  it('returns empty array when errors field is absent', () => {
    expect(extractSemgrepErrors({})).toEqual([]);
  });

  it('returns empty array when errors field is not an array', () => {
    expect(extractSemgrepErrors({ errors: 'bad' as unknown as unknown[] })).toEqual([]);
  });

  it('formats errors with type prefix', () => {
    const out = extractSemgrepErrors({
      errors: [{ type: 'SemgrepError', message: 'something went wrong' }],
    });
    expect(out).toHaveLength(1);
    expect(out[0]).toBe('[SemgrepError] something went wrong');
  });

  it('formats errors without type when type is missing', () => {
    const out = extractSemgrepErrors({
      errors: [{ message: 'parse error' }],
    });
    expect(out[0]).toBe('parse error');
  });

  it('handles non-string message with fallback', () => {
    const out = extractSemgrepErrors({
      errors: [{ type: 'Unknown', message: 42 }],
    });
    expect(out[0]).toBe('[Unknown] unknown semgrep error');
  });
});
