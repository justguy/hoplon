/**
 * adapters/behaviorTestRunner.ts — t-067 host-owned behavior test runner seam.
 *
 * Behavior verification runs tests OUTSIDE Hoplon's deterministic structural
 * kernel. The adapter is:
 *
 *   - host-owned: the host chooses the test framework, the sandboxing story,
 *     CPU/time budgets, concurrency, and isolation
 *   - authoritative on failure evidence: Hoplon echoes stdout/stderr,
 *     exit status, and structured failures verbatim; no silent truncation
 *   - advisory: the engine core never reads the result for PASS/BLOCK
 *   - optional: when omitted the session surfaces
 *     `status: 'UNAVAILABLE', outcome: 'NOT_RUN', unavailabilityReason: 'no_runner'`
 *     rather than fabricating a pass
 *
 * Two concrete adapters ship here:
 *
 *   - `createNoopBehaviorTestRunner()` — surfaces `runnerUnavailable` without
 *     spawning anything. Suitable for hosts that have not wired a real
 *     runner yet but still want the contract seam present in describeCapabilities.
 *   - `createStubBehaviorTestRunner(fixtures)` — deterministic reference for
 *     tests: the caller seeds the result a given `(runFullSuite, testFiles)`
 *     call should produce, and the adapter replays it verbatim.
 *
 * Real host implementations live outside this package (e.g. a Vitest-backed
 * runner in the Phalanx host). Those adapters spawn the framework process,
 * enforce sandboxing, and map the framework's native reporter output into
 * `BehaviorTestRunOutcome`.
 */

import type {
  VerifyBehaviorEvidence,
  VerifyBehaviorExitStatus,
  VerifyBehaviorFailingTest,
} from '../contracts/verifyBehavior.js';

// ---------------------------------------------------------------------------
// Request / response types
// ---------------------------------------------------------------------------

export interface BehaviorTestRunRequest {
  /** The tests the caller wants run, sorted for determinism. Empty when `runFullSuite: true`. */
  readonly testFiles: readonly string[];
  /**
   * When true, the adapter is asked to run the full suite (conservative
   * fallback); `testFiles` is ignored. When false, only the listed files
   * should run.
   */
  readonly runFullSuite: boolean;
  /**
   * Filesystem root the adapter should anchor execution against. Usually the
   * host workspace; the host decides whether to sandbox it.
   */
  readonly projectRoot: string;
  readonly correlationId: string;
  readonly projectId: string;
  readonly runId: string;
  /** Adapter-honored timeout (ms) override. Adapters SHOULD respect this. */
  readonly timeoutMs?: number;
  /** Free-form, content-free metadata forwarded from the caller. */
  readonly meta?: Readonly<Record<string, string>>;
}

export type BehaviorTestRunnerAvailability =
  | { available: true }
  | {
      available: false;
      reason:
        | 'runner_unavailable'
        | 'framework_missing'
        | 'sandbox_unavailable'
        | 'disabled_by_host';
      detail: string | null;
    };

/**
 * Outcome returned by an adapter after a test run.
 *
 * Adapter responsibilities:
 *   - set `runnerId` to a stable, short identifier (e.g. 'host-vitest-v1')
 *   - populate `exitStatus` with the real process outcome
 *   - preserve `stdout` / `stderr` verbatim (or set `truncated: true` if the
 *     adapter itself capped the payload)
 *   - emit each failing test once in `failingTests`; never coalesce failures
 *     across tests
 *   - report `passingTestCount` / `skippedTestCount` from the runner's own
 *     report, not a synthesized count
 *
 * Hoplon wraps this outcome into the `VerifyBehaviorResult` envelope without
 * reshaping the evidence.
 */
export interface BehaviorTestRunOutcome {
  readonly runnerId: string;
  readonly startedAt: string;
  readonly completedAt: string;
  readonly durationMs: number;
  readonly workingDirectory: string | null;
  readonly exitStatus: VerifyBehaviorExitStatus;
  readonly failingTests: readonly VerifyBehaviorFailingTest[];
  readonly passingTestCount: number;
  readonly skippedTestCount: number;
  readonly stdout: string | null;
  readonly stderr: string | null;
  readonly structured: unknown | null;
  readonly truncated: boolean;
}

export interface BehaviorTestRunnerAdapter {
  /** Stable identifier (e.g. 'noop-behavior-runner', 'host-vitest-v1'). */
  readonly id: string;
  /** Advisory availability probe. Adapters MAY return false before work starts. */
  describeAvailability(signal?: AbortSignal): Promise<BehaviorTestRunnerAvailability>;
  /**
   * Run the tests the caller asked for. Adapters MUST return a populated
   * `BehaviorTestRunOutcome`; throwing bubbles up to Hoplon and surfaces as
   * `status: 'DEGRADED', outcome: 'NOT_RUN', unavailabilityReason: 'runner_error'`.
   */
  run(
    req: BehaviorTestRunRequest,
    signal?: AbortSignal,
  ): Promise<BehaviorTestRunOutcome>;
}

// ---------------------------------------------------------------------------
// Helpers used by ref implementations + composer
// ---------------------------------------------------------------------------

export function createEmptyEvidence(): VerifyBehaviorEvidence {
  return {
    failingTests: [],
    passingTestCount: 0,
    skippedTestCount: 0,
    stdout: null,
    stderr: null,
    structured: null,
    truncated: false,
  };
}

export function createNotRunExitStatus(
  reason: string,
): VerifyBehaviorExitStatus {
  return {
    kind: 'not_run',
    code: null,
    signal: null,
    reason,
  };
}

// ---------------------------------------------------------------------------
// createNoopBehaviorTestRunner — honest "unavailable" reference
// ---------------------------------------------------------------------------

/**
 * Returns an adapter whose `describeAvailability` always reports
 * `available: false` and whose `run` immediately returns a NOT_RUN-style
 * outcome. Used as the default when describeCapabilities needs a seam
 * present but the host has not injected a real runner.
 */
export function createNoopBehaviorTestRunner(): BehaviorTestRunnerAdapter {
  return {
    id: 'noop-behavior-runner',
    async describeAvailability() {
      return {
        available: false,
        reason: 'runner_unavailable',
        detail: 'no behavior test runner injected',
      };
    },
    async run() {
      const iso = new Date(0).toISOString();
      return {
        runnerId: 'noop-behavior-runner',
        startedAt: iso,
        completedAt: iso,
        durationMs: 0,
        workingDirectory: null,
        exitStatus: createNotRunExitStatus('noop behavior runner'),
        failingTests: [],
        passingTestCount: 0,
        skippedTestCount: 0,
        stdout: null,
        stderr: null,
        structured: null,
        truncated: false,
      };
    },
  };
}

// ---------------------------------------------------------------------------
// createStubBehaviorTestRunner — deterministic reference for tests
// ---------------------------------------------------------------------------

export interface StubBehaviorTestRunnerFixture {
  readonly matches:
    | { readonly kind: 'runFullSuite' }
    | {
        readonly kind: 'testFiles';
        readonly testFiles: readonly string[];
      }
    | { readonly kind: 'any' };
  readonly outcome: BehaviorTestRunOutcome;
}

export interface StubBehaviorTestRunnerOptions {
  readonly id?: string;
  readonly availability?: BehaviorTestRunnerAvailability;
  readonly fixtures: readonly StubBehaviorTestRunnerFixture[];
  /**
   * Optional adapter-level error the runner should throw on `run()`. Used by
   * tests to exercise the DEGRADED/runner_error path.
   */
  readonly throwOnRun?: Error;
}

export function createStubBehaviorTestRunner(
  opts: StubBehaviorTestRunnerOptions,
): BehaviorTestRunnerAdapter {
  const id = opts.id ?? 'stub-behavior-runner';
  const availability: BehaviorTestRunnerAvailability =
    opts.availability ?? { available: true };

  return {
    id,
    async describeAvailability() {
      return availability;
    },
    async run(req) {
      if (opts.throwOnRun) {
        throw opts.throwOnRun;
      }
      const match = findFixture(opts.fixtures, req);
      if (!match) {
        return {
          runnerId: id,
          startedAt: new Date(0).toISOString(),
          completedAt: new Date(0).toISOString(),
          durationMs: 0,
          workingDirectory: req.projectRoot,
          exitStatus: createNotRunExitStatus(
            'stub runner had no matching fixture',
          ),
          failingTests: [],
          passingTestCount: 0,
          skippedTestCount: 0,
          stdout: null,
          stderr: null,
          structured: null,
          truncated: false,
        };
      }
      return match.outcome;
    },
  };
}

function findFixture(
  fixtures: readonly StubBehaviorTestRunnerFixture[],
  req: BehaviorTestRunRequest,
): StubBehaviorTestRunnerFixture | null {
  for (const fx of fixtures) {
    if (fx.matches.kind === 'any') return fx;
    if (fx.matches.kind === 'runFullSuite' && req.runFullSuite) return fx;
    if (fx.matches.kind === 'testFiles' && !req.runFullSuite) {
      if (sameSortedFiles(fx.matches.testFiles, req.testFiles)) return fx;
    }
  }
  return null;
}

function sameSortedFiles(
  a: readonly string[],
  b: readonly string[],
): boolean {
  if (a.length !== b.length) return false;
  const aa = [...a].sort();
  const bb = [...b].sort();
  for (let i = 0; i < aa.length; i += 1) {
    if (aa[i] !== bb[i]) return false;
  }
  return true;
}
