/**
 * @phalanx/hoplon-static-analysis-semgrep
 *
 * LGPL-2.1-or-later — this package must NOT be bundled into the MIT-licensed
 * @phalanx/hoplon core. See LICENSE and ADR 0001 D15 for rationale.
 *
 * Usage:
 *   import { createSemgrepAnalyzer } from '@phalanx/hoplon-static-analysis-semgrep';
 *   const analyzer = createSemgrepAnalyzer({ binaryPath: 'semgrep', configPath: 'auto' });
 *   const engine = createHoplonEngine({ ..., staticAnalysis: analyzer });
 *
 * The analyzer implements StaticAnalysisAdapter from @phalanx/hoplon (MIT core).
 * The interface contract lives in core; only this implementation is LGPL.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { StaticAnalysisAdapter } from '@phalanx/hoplon';
import { parseSemgrepOutput, ParseSemgrepOutputError } from './parseOutput.js';

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Options
// ---------------------------------------------------------------------------

export interface SemgrepAnalyzerOptions {
  /**
   * Path to the semgrep binary.
   * Default: 'semgrep' (resolved from PATH).
   */
  binaryPath?: string;

  /**
   * Semgrep config/ruleset.
   * Passed as --config <configPath>.
   * Default: 'auto' (semgrep's built-in auto-detection).
   */
  configPath?: string;

  /**
   * Timeout in milliseconds for each semgrep invocation.
   * Default: 30000 (30 seconds).
   */
  timeoutMs?: number;
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create a StaticAnalysisAdapter backed by semgrep.
 *
 * The adapter shells out to `semgrep --config <config> --json <file>` for each
 * file in the request, aggregates findings, and returns BLOCK if any finding
 * has severity "error", PASS otherwise.
 *
 * LGPL note: semgrep itself is LGPL-2.1-or-later. This adapter is therefore
 * also LGPL-2.1-or-later and must remain in this separate plugin package.
 * It must never be imported from or bundled into @phalanx/hoplon core.
 *
 * @param opts - optional configuration
 * @returns StaticAnalysisAdapter
 */
export function createSemgrepAnalyzer(opts: SemgrepAnalyzerOptions = {}): StaticAnalysisAdapter {
  const binaryPath = opts.binaryPath ?? 'semgrep';
  const configPath = opts.configPath ?? 'auto';
  const timeoutMs = opts.timeoutMs ?? 30_000;

  return {
    async analyze(req: { files: string[] }) {
      if (req.files.length === 0) {
        return { status: 'PASS', findings: [] };
      }

      const allFindings: ReturnType<typeof parseSemgrepOutput> = [];

      for (const file of req.files) {
        const findings = await runSemgrep({
          binaryPath,
          configPath,
          file,
          timeoutMs,
        });
        allFindings.push(...findings);
      }

      const hasError = allFindings.some((f) => f.severity === 'error');
      return {
        status: hasError ? 'BLOCK' : 'PASS',
        findings: allFindings,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

interface RunSemgrepOptions {
  binaryPath: string;
  configPath: string;
  file: string;
  timeoutMs: number;
}

/**
 * Shell out to semgrep for a single file and return parsed findings.
 * semgrep exits with code 1 when findings exist (expected); we handle that.
 * Any other non-zero exit (code >= 2) is a real error.
 */
async function runSemgrep(opts: RunSemgrepOptions): Promise<ReturnType<typeof parseSemgrepOutput>> {
  const { binaryPath, configPath, file, timeoutMs } = opts;
  const args = ['--config', configPath, '--json', file];

  let stdout: string;
  try {
    const result = await execFileAsync(binaryPath, args, {
      timeout: timeoutMs,
      // semgrep can produce large output; give it room
      maxBuffer: 32 * 1024 * 1024,
    });
    stdout = result.stdout;
  } catch (err: unknown) {
    // execFile rejects when exit code !== 0
    // semgrep uses exit code 1 to signal "findings exist" — not a hard error.
    // Exit code 2+ is a genuine failure.
    const execErr = err as NodeJS.ErrnoException & { stdout?: string; code?: number | string };
    const exitCode = typeof execErr.code === 'number' ? execErr.code : null;

    if (exitCode === 1 && typeof execErr.stdout === 'string') {
      // Findings present — parse normally
      stdout = execErr.stdout;
    } else {
      throw new SemgrepExecutionError(
        `semgrep exited with code ${exitCode ?? 'unknown'} for file "${file}": ${execErr.message}`,
        exitCode,
      );
    }
  }

  try {
    return parseSemgrepOutput(stdout);
  } catch (err: unknown) {
    if (err instanceof ParseSemgrepOutputError) {
      throw new SemgrepExecutionError(
        `Failed to parse semgrep output for file "${file}": ${err.message}`,
        null,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

/**
 * Thrown when semgrep fails to execute or produces unparseable output.
 * Callers integrating with HoplonEngine should wrap this in AdapterError.
 */
export class SemgrepExecutionError extends Error {
  override readonly name = 'SemgrepExecutionError';
  readonly exitCode: number | null;

  constructor(message: string, exitCode: number | null) {
    super(message);
    this.exitCode = exitCode;
  }
}

// ---------------------------------------------------------------------------
// Re-exports for consumers who need the parse utilities directly
// ---------------------------------------------------------------------------

export { parseSemgrepOutput, ParseSemgrepOutputError } from './parseOutput.js';
