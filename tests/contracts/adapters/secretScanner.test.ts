/**
 * Contract tests for createBuiltinRegexScanner — Slice C6.
 *
 * Proves: pattern detection, line number accuracy, redaction correctness,
 * custom patterns, non-UTF-8 resilience, and performance sanity.
 *
 * Does NOT modify tests/contracts/secretScanner.test.ts (A3.1 schema tests).
 */

import { describe, it, expect } from 'vitest';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import { BUILTIN_PATTERNS } from '../../../src/hoplon/adapters/secretScanner/patterns.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a plain string to Uint8Array using UTF-8. */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Run scanner on a plain string with default patterns. */
function scan(content: string) {
  return createBuiltinRegexScanner().scan({ path: 'test.txt', content: enc(content) });
}

// ---------------------------------------------------------------------------
// 1. Each pattern detected — one fixture per default pattern
// ---------------------------------------------------------------------------

describe('each default pattern — detected', () => {
  it('AWS_ACCESS_KEY_ID — detects AKIA key', async () => {
    const findings = await scan('key=AKIAIOSFODNN7EXAMPLE');
    const match = findings.find((f) => f.patternName === 'AWS_ACCESS_KEY_ID');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('AWS_SECRET_ACCESS_KEY — detects 40-char base64 string', async () => {
    // 40 alphanumeric chars — matches the heuristic
    const secret = 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY';
    const findings = await scan(`AWS_SECRET=${secret}`);
    const match = findings.find((f) => f.patternName === 'AWS_SECRET_ACCESS_KEY');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('GITHUB_PAT_CLASSIC — detects ghp_ token', async () => {
    const pat = 'ghp_' + 'A'.repeat(36);
    const findings = await scan(`token = ${pat}`);
    const match = findings.find((f) => f.patternName === 'GITHUB_PAT_CLASSIC');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('GITHUB_PAT_FINE_GRAINED — detects github_pat_ token', async () => {
    const pat = 'github_pat_' + 'B'.repeat(82);
    const findings = await scan(`token = ${pat}`);
    const match = findings.find((f) => f.patternName === 'GITHUB_PAT_FINE_GRAINED');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('GITHUB_APP_TOKEN — detects ghs_ token', async () => {
    const token = 'ghs_' + 'C'.repeat(36);
    const findings = await scan(`token = ${token}`);
    const match = findings.find((f) => f.patternName === 'GITHUB_APP_TOKEN');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('PRIVATE_KEY_PEM — detects RSA private key header', async () => {
    const findings = await scan('-----BEGIN RSA PRIVATE KEY-----');
    const match = findings.find((f) => f.patternName === 'PRIVATE_KEY_PEM');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('PRIVATE_KEY_PEM — detects generic PRIVATE KEY header', async () => {
    const findings = await scan('-----BEGIN PRIVATE KEY-----');
    const match = findings.find((f) => f.patternName === 'PRIVATE_KEY_PEM');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('SLACK_TOKEN — detects xoxb token', async () => {
    const findings = await scan('slack_token=xoxb-12345-67890-abcdef');
    const match = findings.find((f) => f.patternName === 'SLACK_TOKEN');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('STRIPE_SECRET_KEY — detects sk_live_ key', async () => {
    const key = 'sk_live_' + 'x'.repeat(24);
    const findings = await scan(`STRIPE_KEY=${key}`);
    const match = findings.find((f) => f.patternName === 'STRIPE_SECRET_KEY');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('STRIPE_SECRET_KEY — detects sk_test_ key', async () => {
    const key = 'sk_test_' + 'y'.repeat(24);
    const findings = await scan(`STRIPE_KEY=${key}`);
    const match = findings.find((f) => f.patternName === 'STRIPE_SECRET_KEY');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('GENERIC_API_KEY — detects api_key assignment', async () => {
    const findings = await scan('api_key = abcdefghij1234567890');
    const match = findings.find((f) => f.patternName === 'GENERIC_API_KEY');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });

  it('GENERIC_HIGH_ENTROPY_HEX — detects 40-char hex string', async () => {
    // 40 lowercase hex chars (SHA-1 length)
    const hex = 'a'.repeat(40);
    const findings = await scan(`hash=${hex}`);
    const match = findings.find((f) => f.patternName === 'GENERIC_HIGH_ENTROPY_HEX');
    expect(match).toBeDefined();
    expect(match?.lineNumber).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 2. Multiple lines — correct lineNumber per finding
// ---------------------------------------------------------------------------

describe('multiple lines — lineNumber accuracy', () => {
  it('detects secrets on lines 1, 5, 10', async () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const ghpPat = 'ghp_' + 'Z'.repeat(36);
    const slackToken = 'xoxb-111-222-abcdefg';

    // Build a 10-line file
    const lines = Array.from({ length: 10 }, () => 'nothing here');
    lines[0] = `key=${awsKey}`;
    lines[4] = `token=${ghpPat}`;
    lines[9] = `slack=${slackToken}`;

    const findings = await scan(lines.join('\n'));

    const awsFinding = findings.find((f) => f.patternName === 'AWS_ACCESS_KEY_ID');
    const ghpFinding = findings.find((f) => f.patternName === 'GITHUB_PAT_CLASSIC');
    const slackFinding = findings.find((f) => f.patternName === 'SLACK_TOKEN');

    expect(awsFinding?.lineNumber).toBe(1);
    expect(ghpFinding?.lineNumber).toBe(5);
    expect(slackFinding?.lineNumber).toBe(10);
  });
});

// ---------------------------------------------------------------------------
// 3. Multiple matches on one line — two findings, same lineNumber
// ---------------------------------------------------------------------------

describe('multiple matches on one line', () => {
  it('two AWS access key IDs on the same line → two findings with same lineNumber', async () => {
    const key1 = 'AKIAIOSFODNN7EXAMPLE';
    const key2 = 'AKIAI99S8EXAMPLE1234';
    const content = `${key1} and ${key2}`;

    const findings = await scan(content);
    const awsFindings = findings.filter((f) => f.patternName === 'AWS_ACCESS_KEY_ID');

    expect(awsFindings.length).toBe(2);
    expect(awsFindings[0]?.lineNumber).toBe(1);
    expect(awsFindings[1]?.lineNumber).toBe(1);

    // Each finding's snippet should contain the placeholder for the matched key
    // and neither snippet should contain the raw key value.
    expect(awsFindings[0]?.redactedSnippet).toContain('[REDACTED_AWS_ACCESS_KEY_ID]');
    expect(awsFindings[1]?.redactedSnippet).toContain('[REDACTED_AWS_ACCESS_KEY_ID]');
  });
});

// ---------------------------------------------------------------------------
// 4. No secrets → empty array
// ---------------------------------------------------------------------------

describe('no secrets → empty array', () => {
  it('returns empty array for completely clean content', async () => {
    const clean = [
      'import { foo } from "./bar.js";',
      'const x = 42;',
      'function hello() { return "world"; }',
      '// just a comment',
    ].join('\n');

    const findings = await scan(clean);
    expect(findings).toEqual([]);
  });

  it('returns empty array for empty content', async () => {
    const scanner = createBuiltinRegexScanner();
    const findings = await scanner.scan({ path: 'empty.txt', content: new Uint8Array(0) });
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. Redaction correctness (critical) — raw secret must not appear anywhere
// ---------------------------------------------------------------------------

describe('redaction correctness — raw secret must never appear in findings', () => {
  it('AWS_ACCESS_KEY_ID: raw key absent from all finding fields', async () => {
    const rawKey = 'AKIAIOSFODNN7EXAMPLE';
    const findings = await scan(`export const AWS_KEY = "${rawKey}";`);

    expect(findings.length).toBeGreaterThan(0);
    // The raw secret must not appear in any serialised finding field.
    const serialised = JSON.stringify(findings);
    expect(serialised.includes(rawKey)).toBe(false);
  });

  it('GITHUB_PAT_CLASSIC: raw token absent from all finding fields', async () => {
    // 36 uppercase alphanumeric chars — matches GITHUB_PAT_CLASSIC pattern
    const rawToken = 'ghp_' + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ1234567890';
    const findings = await scan(`const token = "${rawToken}";`);

    expect(findings.length).toBeGreaterThan(0);
    expect(JSON.stringify(findings).includes(rawToken)).toBe(false);
  });

  it('PRIVATE_KEY_PEM: header absent from patternName and lineNumber fields', async () => {
    const rawHeader = '-----BEGIN RSA PRIVATE KEY-----';
    const findings = await scan(rawHeader);

    expect(findings.length).toBeGreaterThan(0);
    // patternName must not contain the raw header
    for (const f of findings) {
      expect(f.patternName).not.toContain('BEGIN');
      expect(f.lineNumber).toBeGreaterThan(0);
    }
    // The full finding JSON must not contain the raw matched substring
    // (the entire header IS the match, so it must be fully redacted)
    expect(JSON.stringify(findings).includes(rawHeader)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 6. Custom patterns — only those patterns are checked
// ---------------------------------------------------------------------------

describe('custom patterns', () => {
  it('uses only the custom pattern set when opts.patterns is provided', async () => {
    const customPattern = {
      name: 'CUSTOM_SECRET',
      regex: /SECRET_VALUE_[A-Z]{8}/g,
    };
    const scanner = createBuiltinRegexScanner({ patterns: [customPattern] });

    // A line with an AWS key that would trigger default patterns
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    // A line with a custom secret
    const customSecret = 'SECRET_VALUE_ABCDEFGH';

    const findings = await scanner.scan({
      path: 'test.txt',
      content: enc(`${awsKey}\n${customSecret}`),
    });

    // Should find the custom secret
    const customFinding = findings.find((f) => f.patternName === 'CUSTOM_SECRET');
    expect(customFinding).toBeDefined();
    expect(customFinding?.lineNumber).toBe(2);

    // Should NOT find the AWS key (default patterns were replaced)
    const awsFinding = findings.find((f) => f.patternName === 'AWS_ACCESS_KEY_ID');
    expect(awsFinding).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Empty patterns array → empty findings for any input
// ---------------------------------------------------------------------------

describe('empty patterns array', () => {
  it('returns empty array regardless of content when patterns is []', async () => {
    const scanner = createBuiltinRegexScanner({ patterns: [] });
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    const findings = await scanner.scan({ path: 'test.txt', content: enc(awsKey) });
    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 8. Non-UTF-8 bytes — does not throw; returns findings from valid segments
// ---------------------------------------------------------------------------

describe('non-UTF-8 bytes', () => {
  it('does not throw on invalid byte sequences', async () => {
    // Build a Uint8Array with invalid UTF-8 bytes (0xFF, 0xFE are invalid lead bytes)
    const invalid = new Uint8Array([0xff, 0xfe, 0x80, 0x90, 0x00]);
    const scanner = createBuiltinRegexScanner();
    // Must not throw
    await expect(scanner.scan({ path: 'binary.bin', content: invalid })).resolves.not.toThrow();
  });

  it('detects secrets in valid UTF-8 segments surrounding invalid bytes', async () => {
    const awsKey = 'AKIAIOSFODNN7EXAMPLE';
    // Prepend invalid bytes before valid content containing a secret
    const validPart = new TextEncoder().encode(`key=${awsKey}`);
    const invalidPrefix = new Uint8Array([0xff, 0xfe]);
    const combined = new Uint8Array(invalidPrefix.length + validPart.length);
    combined.set(invalidPrefix, 0);
    combined.set(validPart, invalidPrefix.length);

    const scanner = createBuiltinRegexScanner();
    const findings = await scanner.scan({ path: 'mixed.txt', content: combined });

    // The AWS key in the valid segment must still be detected
    const awsFinding = findings.find((f) => f.patternName === 'AWS_ACCESS_KEY_ID');
    expect(awsFinding).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// 9. Performance sanity — 100 KB clean file under 50ms (soft: 500ms ceiling)
// ---------------------------------------------------------------------------

describe('performance sanity', () => {
  it('scans a 100 KB clean file in under 500ms', async () => {
    // Generate ~100 KB of clean text with no secret patterns
    const chunk = 'the quick brown fox jumps over the lazy dog\n';
    const repetitions = Math.ceil((100 * 1024) / chunk.length);
    const bigContent = chunk.repeat(repetitions);

    const scanner = createBuiltinRegexScanner();
    const content = enc(bigContent);

    const start = performance.now();
    const findings = await scanner.scan({ path: 'big.txt', content });
    const elapsed = performance.now() - start;

    // No secrets in clean content (false positives tolerated but not expected
    // for this specific clean fixture)
    expect(findings).toEqual([]);

    // Soft ceiling: even on slow CI, 500ms is generous for a 100 KB text scan
    expect(elapsed).toBeLessThan(500);
  });
});

// ---------------------------------------------------------------------------
// 10. Line number correctness at edges
// ---------------------------------------------------------------------------

describe('line number correctness at edges', () => {
  it('secret on line 1 → lineNumber is 1', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const findings = await scan(key);
    const f = findings.find((x) => x.patternName === 'AWS_ACCESS_KEY_ID');
    expect(f?.lineNumber).toBe(1);
  });

  it('secret on last line with no trailing newline → correct lineNumber', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    // 5-line file; secret is on line 5 with no trailing newline
    const content = ['line1', 'line2', 'line3', 'line4', `key=${key}`].join('\n');

    const findings = await scan(content);
    const f = findings.find((x) => x.patternName === 'AWS_ACCESS_KEY_ID');
    expect(f?.lineNumber).toBe(5);
  });

  it('secret at last line WITH trailing newline → correct lineNumber', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    // 5-line file with trailing newline (produces empty line 6, secret is on line 5)
    const content = ['line1', 'line2', 'line3', 'line4', `key=${key}`, ''].join('\n');

    const findings = await scan(content);
    const f = findings.find((x) => x.patternName === 'AWS_ACCESS_KEY_ID');
    expect(f?.lineNumber).toBe(5);
  });

  it('CRLF line endings — secret line number is correct', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    // Windows CRLF: each line ends with \r\n
    const content = `line1\r\nline2\r\nline3 key=${key}\r\nline4`;

    const findings = await scan(content);
    const f = findings.find((x) => x.patternName === 'AWS_ACCESS_KEY_ID');
    expect(f?.lineNumber).toBe(3);
  });

  it('mixed CR+LF endings — lines are normalised before numbering', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    // Mix bare \r on line 2 boundary, then secret on line 3
    const content = `line1\rline2\nkey=${key}`;

    const findings = await scan(content);
    const f = findings.find((x) => x.patternName === 'AWS_ACCESS_KEY_ID');
    expect(f?.lineNumber).toBe(3);
  });

  it('pattern found on a middle line → lineNumber matches', async () => {
    const key = 'AKIAIOSFODNN7EXAMPLE';
    const lines = Array.from({ length: 7 }, (_, i) => `line${i + 1}`);
    lines[3] = `mid=${key}`; // line 4 (1-indexed)

    const findings = await scan(lines.join('\n'));
    const f = findings.find((x) => x.patternName === 'AWS_ACCESS_KEY_ID');
    expect(f?.lineNumber).toBe(4);
  });
});

// ---------------------------------------------------------------------------
// Additional: BUILTIN_PATTERNS export sanity
// ---------------------------------------------------------------------------

describe('BUILTIN_PATTERNS export', () => {
  it('exports a non-empty array of named patterns with compiled regexes', () => {
    expect(BUILTIN_PATTERNS.length).toBeGreaterThan(0);
    for (const p of BUILTIN_PATTERNS) {
      expect(typeof p.name).toBe('string');
      expect(p.name.length).toBeGreaterThan(0);
      expect(p.regex).toBeInstanceOf(RegExp);
      // All built-in regexes must use the global flag
      expect(p.regex.flags).toContain('g');
    }
  });
});
