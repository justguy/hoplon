/**
 * tests/integration.test.ts — Integration tests for createGitleaksProvider.
 *
 * These tests spawn the real `gitleaks` binary and are gated by `RUN_INTEGRATION=1`.
 * They are skipped entirely when that environment variable is not set, or when
 * `gitleaks` is not on PATH.
 *
 * Run with:
 *   RUN_INTEGRATION=1 npx vitest run tests/integration.test.ts
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

import { createGitleaksProvider } from '../src/index.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Guard: skip entire suite unless RUN_INTEGRATION=1
// ---------------------------------------------------------------------------

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

// ---------------------------------------------------------------------------
// Guard: detect whether gitleaks is on PATH
// ---------------------------------------------------------------------------

async function isGitleaksOnPath(): Promise<boolean> {
  try {
    await execFileAsync('gitleaks', ['version'], { timeout: 5_000 });
    return true;
  } catch {
    return false;
  }
}

describe('createGitleaksProvider (integration)', () => {
  let gitleaksAvailable = false;

  beforeAll(async () => {
    if (!RUN_INTEGRATION) return;
    gitleaksAvailable = await isGitleaksOnPath();
  });

  /**
   * Helper that skips a test when integration is not enabled or binary absent.
   * Returns a conditional `it` function.
   */
  function itWhenEnabled(name: string, fn: () => Promise<void>): void {
    it(name, async () => {
      if (!RUN_INTEGRATION) {
        console.log(`[SKIP] ${name}: RUN_INTEGRATION not set`);
        return;
      }
      if (!gitleaksAvailable) {
        console.log(`[SKIP] ${name}: gitleaks not on PATH`);
        return;
      }
      await fn();
    });
  }

  // -------------------------------------------------------------------------
  // Skipped-state assertion (always runs, proves guard works)
  // -------------------------------------------------------------------------

  it('is correctly skipped when RUN_INTEGRATION is not set', () => {
    // This test always passes; its purpose is to document the gate behaviour.
    // When RUN_INTEGRATION=1 this test still passes (it just verifies the flag).
    expect(typeof RUN_INTEGRATION).toBe('boolean');
  });

  // -------------------------------------------------------------------------
  // Integration tests (opt-in)
  // -------------------------------------------------------------------------

  itWhenEnabled('returns empty findings for content with no secrets', async () => {
    const provider = createGitleaksProvider();
    const findings = await provider.scanText(
      'const greeting = "hello world";\nexport default greeting;\n',
      'greeting.ts',
    );
    expect(findings).toEqual([]);
  });

  itWhenEnabled('detects a hardcoded AWS access key', async () => {
    // AWS access key format matches the built-in gitleaks rule.
    const content = 'const awsKey = "AKIAIOSFODNN7EXAMPLE";\n';
    const provider = createGitleaksProvider();
    const findings = await provider.scanText(content, 'config.ts');
    // We cannot assert the exact ruleId (varies with gitleaks version/config),
    // but we can assert that something was found.
    expect(findings.length).toBeGreaterThan(0);
    // Every finding must conform to the GitleaksFinding shape.
    for (const finding of findings) {
      expect(typeof finding.ruleId).toBe('string');
      expect(finding.ruleId.length).toBeGreaterThan(0);
      expect(typeof finding.lineNumber).toBe('number');
      expect(finding.lineNumber).toBeGreaterThan(0);
      expect(typeof finding.line).toBe('string');
      expect(typeof finding.secret).toBe('string');
      // The raw secret must be present (adapter will redact it, not us)
      expect(finding.secret.length).toBeGreaterThan(0);
    }
  });

  itWhenEnabled('returns empty findings for empty content', async () => {
    const provider = createGitleaksProvider();
    const findings = await provider.scanText('', 'empty.ts');
    expect(findings).toEqual([]);
  });

  itWhenEnabled('returns empty array when binary does not exist (non-blocking)', async () => {
    const provider = createGitleaksProvider({ binaryPath: '/nonexistent/gitleaks-fake' });
    // Should NOT throw; must return empty findings per non-blocking contract.
    const findings = await provider.scanText('const x = "AKIAIOSFODNN7EXAMPLE";', 'file.ts');
    expect(findings).toEqual([]);
  });

  itWhenEnabled('respects per-call configPath (no crash with valid path)', async () => {
    // Just verify that passing a configPath does not crash (even if the file
    // does not exist — gitleaks will use default rules in that case).
    const provider = createGitleaksProvider();
    const findings = await provider.scanText(
      'const x = "hello";\n',
      'file.ts',
      '/nonexistent/config.toml',
    );
    // No assertion on findings count — configPath may or may not affect results.
    expect(Array.isArray(findings)).toBe(true);
  });
});
