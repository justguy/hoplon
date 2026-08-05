/**
 * Contract tests for GL1 — createGitleaksSecretScanner + MockGitleaksProvider.
 *
 * Proves:
 *   1. SecretScannerAdapter contract satisfied (scan returns SecretFinding[])
 *   2. Redaction enforced — raw secret NEVER appears in serialised SecretFinding
 *   3. H13 content-free — scanned text never reaches emitted events
 *   4. Findings map correctly (ruleId → patternName, lineNumber, redactedSnippet)
 *   5. Empty content → empty findings (no crash)
 *   6. File not in fixture map → empty findings
 *   7. configPath plumbed through (received by provider)
 *   8. SecretFindingSchema validation passes on every returned finding
 *   9. Multiple findings per file — all redacted independently
 *  10. Mock provider fixture isolation (copy, not reference)
 */

import { describe, it, expect, vi } from 'vitest';
import { createGitleaksSecretScanner } from '../../../src/hoplon/adapters/secretScanner/gitleaks.js';
import { createMockGitleaksProvider } from '../../../src/hoplon/adapters/secretScanner/mockGitleaksProvider.js';
import type { GitleaksFinding, GitleaksProvider } from '../../../src/hoplon/adapters/secretScanner/gitleaks.js';
import { SecretFindingSchema } from '../../../src/hoplon/adapters/secretScanner.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Encode a plain string to Uint8Array using UTF-8. */
function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Build a single-finding fixture for a named file. */
function singleFinding(
  filename: string,
  finding: GitleaksFinding,
) {
  return createMockGitleaksProvider([{ filename, findings: [finding] }]);
}

// ---------------------------------------------------------------------------
// Canonical fixture finding (raw — adapter must redact before returning)
// ---------------------------------------------------------------------------

const FIXTURE_AWS: GitleaksFinding = {
  ruleId: 'aws-access-token',
  lineNumber: 2,
  line: 'const key = "AKIAIOSFODNN7EXAMPLE";',
  secret: 'AKIAIOSFODNN7EXAMPLE',
};

const FIXTURE_GH_PAT: GitleaksFinding = {
  ruleId: 'github-pat',
  lineNumber: 5,
  line: `const token = "${'ghp_' + 'A'.repeat(36)}";`,
  secret: 'ghp_' + 'A'.repeat(36),
};

// ---------------------------------------------------------------------------
// 1. Basic contract — scan returns SecretFinding[]
// ---------------------------------------------------------------------------

describe('SecretScannerAdapter contract', () => {
  it('returns an array of SecretFinding objects', async () => {
    const provider = singleFinding('secrets.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({
      path: 'secrets.ts',
      content: enc(FIXTURE_AWS.line),
    });

    expect(Array.isArray(findings)).toBe(true);
    expect(findings.length).toBe(1);
  });

  it('maps ruleId → patternName correctly', async () => {
    const provider = singleFinding('config.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({
      path: 'config.ts',
      content: enc(FIXTURE_AWS.line),
    });

    expect(finding?.patternName).toBe('aws-access-token');
  });

  it('maps lineNumber correctly', async () => {
    const provider = singleFinding('env.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({
      path: 'env.ts',
      content: enc(FIXTURE_AWS.line),
    });

    expect(finding?.lineNumber).toBe(2);
  });

  it('every returned finding passes SecretFindingSchema', async () => {
    const provider = createMockGitleaksProvider([
      { filename: 'multi.ts', findings: [FIXTURE_AWS, FIXTURE_GH_PAT] },
    ]);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({
      path: 'multi.ts',
      content: enc('anything'),
    });

    for (const f of findings) {
      const result = SecretFindingSchema.safeParse(f);
      expect(result.success, `Schema parse failed: ${JSON.stringify(f)}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. Redaction — raw secret NEVER appears in serialised output
// ---------------------------------------------------------------------------

describe('redaction — raw secret never in SecretFinding', () => {
  it('AWS access key: raw value absent from all finding fields', async () => {
    const raw = FIXTURE_AWS.secret;
    const provider = singleFinding('creds.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({ path: 'creds.ts', content: enc(raw) });

    expect(findings.length).toBe(1);
    // Serialise every field — raw secret must not appear anywhere.
    const serialised = JSON.stringify(findings);
    expect(serialised.includes(raw)).toBe(false);
  });

  it('GitHub PAT: raw token absent from all finding fields', async () => {
    const raw = FIXTURE_GH_PAT.secret;
    const provider = singleFinding('tokens.ts', FIXTURE_GH_PAT);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({ path: 'tokens.ts', content: enc(raw) });

    expect(findings.length).toBe(1);
    const serialised = JSON.stringify(findings);
    expect(serialised.includes(raw)).toBe(false);
  });

  it('redactedSnippet contains [REDACTED] placeholder', async () => {
    const provider = singleFinding('key.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({ path: 'key.ts', content: enc(FIXTURE_AWS.line) });

    expect(finding?.redactedSnippet).toContain('[REDACTED]');
  });

  it('redactedSnippet does NOT contain raw secret value', async () => {
    const provider = singleFinding('key.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({ path: 'key.ts', content: enc(FIXTURE_AWS.line) });

    expect(finding?.redactedSnippet.includes(FIXTURE_AWS.secret)).toBe(false);
  });

  it('multiple occurrences of same secret on one line — all redacted', async () => {
    const secret = 'AKIAIOSFODNN7EXAMPLE';
    const doubleLine = `${secret} and ${secret}`;
    const doubleFinding: GitleaksFinding = {
      ruleId: 'aws-access-token',
      lineNumber: 1,
      line: doubleLine,
      secret,
    };
    const provider = singleFinding('double.ts', doubleFinding);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({ path: 'double.ts', content: enc(doubleLine) });

    // Both occurrences must be gone
    expect(finding?.redactedSnippet.includes(secret)).toBe(false);
    // Both placeholders must be present
    const placeholderCount = (finding?.redactedSnippet.match(/\[REDACTED\]/g) ?? []).length;
    expect(placeholderCount).toBe(2);
  });
});

// ---------------------------------------------------------------------------
// 3. H13 content-free — scanned text never reaches emitted events
//
// The adapter itself does not call any emitter. The proof here is structural:
// we verify that the scan() method accepts the injected provider and returns
// only SecretFinding DTOs — no raw text or secret values are returned.
// The engine layer is responsible for not forwarding SecretFinding.redactedSnippet
// into operational events (enforced separately by assertEventIsContentFree).
// ---------------------------------------------------------------------------

describe('H13 content-free — adapter returns structure only', () => {
  it('scan result fields are patternName (string), lineNumber (number), redactedSnippet (string)', async () => {
    const provider = singleFinding('h13.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({ path: 'h13.ts', content: enc(FIXTURE_AWS.line) });

    expect(typeof finding?.patternName).toBe('string');
    expect(typeof finding?.lineNumber).toBe('number');
    expect(typeof finding?.redactedSnippet).toBe('string');
  });

  it('scan result has exactly the three SecretFinding fields (no extras)', async () => {
    const provider = singleFinding('h13b.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({ path: 'h13b.ts', content: enc(FIXTURE_AWS.line) });

    const keys = Object.keys(finding as object).sort();
    expect(keys).toEqual(['lineNumber', 'patternName', 'redactedSnippet'].sort());
  });

  it('raw `secret` field from GitleaksFinding is absent from returned SecretFinding', async () => {
    const provider = singleFinding('h13c.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const [finding] = await scanner.scan({ path: 'h13c.ts', content: enc(FIXTURE_AWS.line) });

    expect('secret' in (finding as object)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. Empty content → empty findings
// ---------------------------------------------------------------------------

describe('empty content', () => {
  it('returns empty array for empty Uint8Array', async () => {
    const provider = singleFinding('empty.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({ path: 'empty.ts', content: new Uint8Array(0) });

    expect(findings).toEqual([]);
  });

  it('does not call provider for empty content', async () => {
    const scanText = vi.fn<GitleaksProvider['scanText']>().mockResolvedValue([]);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: { scanText } });

    await scanner.scan({ path: 'empty.ts', content: new Uint8Array(0) });

    expect(scanText).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// 5. File not in fixture map → empty findings
// ---------------------------------------------------------------------------

describe('file not in fixture map', () => {
  it('returns empty array when filename has no fixture entry', async () => {
    const provider = createMockGitleaksProvider([
      { filename: 'other.ts', findings: [FIXTURE_AWS] },
    ]);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({
      path: 'not-in-fixture.ts',
      content: enc(FIXTURE_AWS.line),
    });

    expect(findings).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 6. configPath plumbed through to provider
// ---------------------------------------------------------------------------

describe('configPath forwarding', () => {
  it('forwards configPath to every scanText call', async () => {
    const expectedConfig = '/path/to/.gitleaks.toml';
    const receivedConfigs: Array<string | undefined> = [];

    const provider: GitleaksProvider = {
      async scanText(_text, _filename, config) {
        receivedConfigs.push(config);
        return [];
      },
    };

    const scanner = createGitleaksSecretScanner({
      gitleaksProvider: provider,
      configPath: expectedConfig,
    });

    await scanner.scan({ path: 'cfg.ts', content: enc('something') });

    expect(receivedConfigs).toHaveLength(1);
    expect(receivedConfigs[0]).toBe(expectedConfig);
  });

  it('passes undefined configPath when not specified', async () => {
    const receivedConfigs: Array<string | undefined> = [];

    const provider: GitleaksProvider = {
      async scanText(_text, _filename, config) {
        receivedConfigs.push(config);
        return [];
      },
    };

    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    await scanner.scan({ path: 'nocfg.ts', content: enc('something') });

    expect(receivedConfigs[0]).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 7. Multiple findings per file
// ---------------------------------------------------------------------------

describe('multiple findings', () => {
  it('returns all findings for a multi-secret file', async () => {
    const provider = createMockGitleaksProvider([
      { filename: 'both.ts', findings: [FIXTURE_AWS, FIXTURE_GH_PAT] },
    ]);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({ path: 'both.ts', content: enc('content') });

    expect(findings.length).toBe(2);
    const patternNames = findings.map((f) => f.patternName).sort();
    expect(patternNames).toEqual(['aws-access-token', 'github-pat'].sort());
  });

  it('all findings have raw secrets redacted', async () => {
    const provider = createMockGitleaksProvider([
      { filename: 'both.ts', findings: [FIXTURE_AWS, FIXTURE_GH_PAT] },
    ]);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const findings = await scanner.scan({ path: 'both.ts', content: enc('content') });

    const serialised = JSON.stringify(findings);
    expect(serialised.includes(FIXTURE_AWS.secret)).toBe(false);
    expect(serialised.includes(FIXTURE_GH_PAT.secret)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 8. Mock provider fixture isolation — mutations don't bleed across scans
// ---------------------------------------------------------------------------

describe('mock provider fixture isolation', () => {
  it('mutating returned findings array does not affect subsequent scans', async () => {
    const provider = singleFinding('iso.ts', FIXTURE_AWS);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    const first = await scanner.scan({ path: 'iso.ts', content: enc('x') });
    // Mutate the returned array
    first.length = 0;

    const second = await scanner.scan({ path: 'iso.ts', content: enc('x') });
    expect(second.length).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// 9. Non-UTF-8 content — does not throw
// ---------------------------------------------------------------------------

describe('non-UTF-8 bytes', () => {
  it('does not throw on invalid byte sequences', async () => {
    const invalid = new Uint8Array([0xff, 0xfe, 0x80, 0x90]);
    const provider = createMockGitleaksProvider([]);
    const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

    await expect(
      scanner.scan({ path: 'binary.bin', content: invalid }),
    ).resolves.not.toThrow();
  });
});
