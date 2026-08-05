/**
 * tests/integration.test.ts — integration tests for createSemgrepAnalyzer.
 *
 * GATED by RUN_INTEGRATION=1. Skipped automatically when the semgrep binary
 * is absent or RUN_INTEGRATION is unset.
 *
 * To run:
 *   RUN_INTEGRATION=1 npx vitest run tests/integration.test.ts
 *
 * Requires: semgrep on PATH (or set binaryPath in options).
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createSemgrepAnalyzer } from '../src/index.js';

const execFileAsync = promisify(execFile);

const RUN_INTEGRATION = process.env['RUN_INTEGRATION'] === '1';

/**
 * Check if semgrep is available on PATH.
 * Returns true only if the binary exists and responds to --version.
 */
async function isSemgrepAvailable(binaryPath = 'semgrep'): Promise<boolean> {
  try {
    await execFileAsync(binaryPath, ['--version'], { timeout: 5000 });
    return true;
  } catch {
    return false;
  }
}

describe.skipIf(!RUN_INTEGRATION)('createSemgrepAnalyzer — integration (RUN_INTEGRATION=1 required)', () => {
  let semgrepAvailable = false;
  let tmpDir = '';

  beforeAll(async () => {
    semgrepAvailable = await isSemgrepAvailable();
    if (semgrepAvailable) {
      tmpDir = await mkdtemp(join(tmpdir(), 'hoplon-semgrep-test-'));
    }
  });

  it('skips gracefully when semgrep binary is not found', async () => {
    const analyzer = createSemgrepAnalyzer({ binaryPath: '__nonexistent_semgrep__' });
    // Should reject with SemgrepExecutionError — binary not found
    await expect(analyzer.analyze({ files: ['dummy.ts'] })).rejects.toThrow();
  });

  it.skipIf(!semgrepAvailable)(
    'returns PASS with empty findings for a clean file',
    async () => {
      const cleanFile = join(tmpDir, 'clean.py');
      await writeFile(cleanFile, 'def hello():\n    return "world"\n', 'utf8');

      const analyzer = createSemgrepAnalyzer({ configPath: 'auto' });
      const result = await analyzer.analyze({ files: [cleanFile] });

      expect(result.status).toBe('PASS');
      expect(Array.isArray(result.findings)).toBe(true);

      await rm(cleanFile, { force: true });
    },
  );

  it.skipIf(!semgrepAvailable)(
    'returns PASS for empty file list',
    async () => {
      const analyzer = createSemgrepAnalyzer();
      const result = await analyzer.analyze({ files: [] });
      expect(result.status).toBe('PASS');
      expect(result.findings).toHaveLength(0);
    },
  );

  it.skipIf(!semgrepAvailable)(
    'findings have required AnalysisFinding shape when violations exist',
    async () => {
      // Write a Python file with a hardcoded secret pattern semgrep commonly detects
      const badFile = join(tmpDir, 'bad.py');
      await writeFile(
        badFile,
        [
          '# A file with a hardcoded secret-like pattern for semgrep detection',
          'PASSWORD = "hardcoded-secret-123"',
          '',
        ].join('\n'),
        'utf8',
      );

      const analyzer = createSemgrepAnalyzer({ configPath: 'auto' });
      const result = await analyzer.analyze({ files: [badFile] });

      // Shape validation — regardless of whether semgrep finds violations
      expect(typeof result.status).toBe('string');
      expect(['PASS', 'BLOCK']).toContain(result.status);
      expect(Array.isArray(result.findings)).toBe(true);

      for (const f of result.findings) {
        expect(typeof f.path).toBe('string');
        expect(typeof f.rule).toBe('string');
        expect(typeof f.message).toBe('string');
        expect(['info', 'warning', 'error']).toContain(f.severity);
      }

      await rm(badFile, { force: true });
    },
  );
});
