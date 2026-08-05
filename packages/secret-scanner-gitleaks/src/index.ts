/**
 * @phalanx/hoplon-secret-scanner-gitleaks
 *
 * Provides `createGitleaksProvider` — a real `GitleaksProvider` implementation
 * that shells out to the `gitleaks` CLI binary via Node's `child_process`.
 *
 * ## Usage
 *
 * ```typescript
 * import { createGitleaksSecretScanner } from '@phalanx/hoplon';
 * import { createGitleaksProvider } from '@phalanx/hoplon-secret-scanner-gitleaks';
 * import { writeFile, mkdtemp, rm } from 'node:fs/promises';
 * import { tmpdir } from 'node:os';
 * import { join } from 'node:path';
 *
 * const provider = createGitleaksProvider({ binaryPath: 'gitleaks' });
 * const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });
 *
 * const findings = await scanner.scan({
 *   path: 'config.ts',
 *   content: Buffer.from('const key = "AKIAIOSFODNN7EXAMPLE";'),
 * });
 * ```
 *
 * ## How it works
 *
 * `createGitleaksProvider` returns a `GitleaksProvider` object. Each call to
 * `scanText(text, filename, configPath?)`:
 *
 * 1. Writes `text` to a temporary file in a unique temp directory. The file
 *    is named after the `filename` argument so gitleaks rule filenames can
 *    be matched (e.g. `.env`, `config.ts`).
 * 2. Invokes:
 *    `gitleaks detect --no-git --source <tempDir> --report-format json --report-path -`
 *    Optionally prepends `--config <configPath>` when provided.
 * 3. Parses stdout JSON via `parseGitleaksOutput`.
 * 4. Cleans up the temp directory.
 * 5. Returns findings, or `[]` on any error (non-blocking contract).
 *
 * Exit code handling:
 * - gitleaks exits 0 when no findings, 1 when findings found (not an error),
 *   and non-zero (not 1) on a real binary error. We treat exit code 0 or 1 as
 *   success; any other exit code is an error but still returns `[]` (non-blocking).
 *
 * ## Isolation
 * This package is intentionally separate from `@phalanx/hoplon` core. Core
 * must NOT depend on it. Only consumers that have `gitleaks` installed need it.
 */

import { execFile as _execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { writeFile, mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, basename } from 'node:path';

import type { GitleaksProvider, GitleaksFinding } from '@phalanx/hoplon';
import { parseGitleaksOutput } from './parseOutput.js';

const execFile = promisify(_execFile);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface GitleaksProviderOptions {
  /**
   * Path to the `gitleaks` binary.
   * Defaults to `'gitleaks'` (resolved from `PATH`).
   */
  binaryPath?: string;
  /**
   * Optional path to a gitleaks TOML configuration file.
   * When provided, passed via `--config <configPath>` to every invocation.
   * A per-call `configPath` from `scanText` takes precedence if both are set.
   */
  configPath?: string;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a real `GitleaksProvider` that invokes the `gitleaks` CLI binary
 * via `child_process.execFile`.
 *
 * The returned provider satisfies the `GitleaksProvider` seam from GL1's
 * `createGitleaksSecretScanner` in `@phalanx/hoplon`.
 *
 * @param opts.binaryPath — path to the gitleaks binary (default: `'gitleaks'`)
 * @param opts.configPath — optional TOML config path (instance-level default)
 */
export function createGitleaksProvider(
  opts: GitleaksProviderOptions = {},
): GitleaksProvider {
  const binaryPath = opts.binaryPath ?? 'gitleaks';
  const instanceConfigPath = opts.configPath;

  return {
    async scanText(
      text: string,
      filename: string,
      callConfigPath?: string,
    ): Promise<GitleaksFinding[]> {
      // Per-call configPath takes precedence over instance-level configPath.
      const resolvedConfigPath = callConfigPath ?? instanceConfigPath;

      // Create a unique temp directory for this scan invocation so concurrent
      // scans never interfere with each other's files.
      let tempDir: string | undefined;
      try {
        tempDir = await mkdtemp(join(tmpdir(), 'hoplon-gitleaks-'));

        // Use only the basename of the filename to avoid path traversal issues
        // when writing to the temp dir. Gitleaks matches rules against the
        // filename, so preserving the base name is important.
        const safeFilename = basename(filename) || 'file';
        const tempFilePath = join(tempDir, safeFilename);

        await writeFile(tempFilePath, text, 'utf-8');

        // Build the argument list.
        const args: string[] = [
          'detect',
          '--no-git',
          '--source', tempDir,
          '--report-format', 'json',
          '--report-path', '-',
        ];

        if (resolvedConfigPath !== undefined) {
          args.push('--config', resolvedConfigPath);
        }

        let stdout = '';
        try {
          const result = await execFile(binaryPath, args, {
            // Capture stdout for JSON parsing; stderr goes to /dev/null conceptually
            // (we only need the report output, not diagnostic messages).
            encoding: 'utf-8',
            // Give gitleaks up to 30 seconds per scan; large files may need time.
            timeout: 30_000,
          });
          stdout = result.stdout;
        } catch (execErr: unknown) {
          // execFile rejects on non-zero exit codes. gitleaks exits with code 1
          // when findings are found (not a failure). We must handle this case.
          const err = execErr as { code?: number; stdout?: string; stderr?: string };
          if (err.code === 1 && typeof err.stdout === 'string') {
            // Exit code 1 = findings found; stdout contains the JSON report.
            stdout = err.stdout;
          } else {
            // A real error (binary not found, timeout, etc.) — return empty
            // per the non-blocking contract.
            return [];
          }
        }

        return parseGitleaksOutput(stdout);
      } catch {
        // Any unexpected error (file write failure, parse error, etc.) —
        // surface as empty findings per the non-blocking contract.
        return [];
      } finally {
        // Always clean up the temp directory.
        if (tempDir !== undefined) {
          await rm(tempDir, { recursive: true, force: true });
        }
      }
    },
  };
}

// Re-export parseOutput utilities for consumers who need to test parsing
// independently (e.g. unit tests that stub execFile).
export { parseGitleaksOutput } from './parseOutput.js';
export type { ParseOutputError } from './parseOutput.js';
