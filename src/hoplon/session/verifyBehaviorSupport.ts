import type {
  BehaviorTestRunnerAdapter,
  BehaviorTestRunnerAvailability,
} from '../adapters/behaviorTestRunner.js';
import { createNotRunExitStatus } from '../adapters/behaviorTestRunner.js';
import type {
  VerifyBehaviorEvidence,
  VerifyBehaviorExecution,
  VerifyBehaviorLinkage,
  VerifyBehaviorNote,
  VerifyBehaviorResult,
  VerifyBehaviorSelection,
} from '../contracts/verifyBehavior.js';
import { composeVerificationSemanticGapSidecar } from '../contracts/verificationIntelligence.js';
import type { ComposeVerifyBehaviorInput } from './verifyBehaviorTypes.js';

export async function safeDescribeAvailability(
  runner: BehaviorTestRunnerAdapter,
  signal: AbortSignal | undefined,
): Promise<
  | { ok: true }
  | {
      ok: false;
      detail: string | null;
      unavailabilityReason: 'runner_unavailable' | 'timeout' | 'aborted';
    }
> {
  let availability: BehaviorTestRunnerAvailability;
  try {
    availability = await runner.describeAvailability(signal);
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      detail,
      unavailabilityReason: coerceUnavailability(err) ?? 'runner_unavailable',
    };
  }
  if (availability.available) return { ok: true };
  return {
    ok: false,
    detail: availability.detail,
    unavailabilityReason: 'runner_unavailable',
  };
}

export function decideOutcome(input: {
  exitStatus: VerifyBehaviorExecution['exitStatus'];
  failingTestCount: number;
}) {
  const { exitStatus, failingTestCount } = input;
  const outcomeNotes: VerifyBehaviorNote[] = [];
  if (failingTestCount > 0) {
    if (exitStatus.kind === 'exit_code' && exitStatus.code === 0) {
      outcomeNotes.push('runner_exit_zero_with_failing_tests');
      return {
        status: 'DEGRADED' as const,
        outcome: 'FAIL' as const,
        unavailabilityReason: null,
        outcomeNotes,
      };
    }
    return {
      status: 'AVAILABLE' as const,
      outcome: 'FAIL' as const,
      unavailabilityReason: null,
      outcomeNotes,
    };
  }
  if (exitStatus.kind === 'exit_code' && exitStatus.code === 0) {
    return {
      status: 'AVAILABLE' as const,
      outcome: 'PASS' as const,
      unavailabilityReason: null,
      outcomeNotes,
    };
  }
  outcomeNotes.push('runner_exit_nonzero_no_failing_tests');
  return {
    status: 'DEGRADED' as const,
    outcome: 'FAIL' as const,
    unavailabilityReason: null,
    outcomeNotes,
  };
}

export function coerceUnavailability(err: unknown): 'timeout' | 'aborted' | null {
  if (err instanceof Error) {
    if (err.name === 'AbortError') return 'aborted';
    if (/timeout/i.test(err.message)) return 'timeout';
  }
  return null;
}

export function buildLinkage(
  input: ComposeVerifyBehaviorInput,
): VerifyBehaviorLinkage {
  return {
    sessionId: input.sessionId,
    snapshotRefId: input.snapshotRefId,
    changedFiles: [...input.changedFiles],
    attemptNumber: input.attemptNumber,
  };
}

export function buildEmptySelection(
  reason:
    | 'no_runner'
    | 'runner_unavailable'
    | 'oracle_failure'
    | 'selection_empty_exact'
    | 'selection_empty_conservative',
): VerifyBehaviorSelection {
  void reason;
  return {
    strategy: 'none',
    testsExecuted: [],
    oracleResult: null,
    coverageConfidence: 'not_applicable',
    modifiedFilesSource: 'none',
  };
}

export function buildEmptyExecution(reason: string | null): VerifyBehaviorExecution {
  return {
    runnerId: null,
    startedAt: null,
    completedAt: null,
    durationMs: null,
    exitStatus: createNotRunExitStatus(reason ?? 'not run'),
    timeoutMs: null,
    workingDirectory: null,
  };
}

interface AssembleInput {
  readonly status: VerifyBehaviorResult['status'];
  readonly outcome: VerifyBehaviorResult['outcome'];
  readonly unavailabilityReason: VerifyBehaviorResult['unavailabilityReason'];
  readonly selection: VerifyBehaviorSelection;
  readonly execution: VerifyBehaviorExecution;
  readonly evidence: VerifyBehaviorEvidence;
  readonly linkage: VerifyBehaviorLinkage;
  readonly correlationId: string;
  readonly generatedAt: string;
  readonly notes: Set<VerifyBehaviorNote>;
  readonly includeSemanticGapIntelligence: boolean;
}

export function assemble(input: AssembleInput): VerifyBehaviorResult {
  const result: VerifyBehaviorResult = {
    version: 1,
    advisory: true,
    status: input.status,
    outcome: input.outcome,
    unavailabilityReason: input.unavailabilityReason,
    selection: input.selection,
    linkage: input.linkage,
    execution: input.execution,
    evidence: input.evidence,
    correlationId: input.correlationId,
    generatedAt: input.generatedAt,
    notes: [...input.notes].sort(),
  };
  const verificationSemanticGap = composeVerificationSemanticGapSidecar({
    verification: result,
    includeSemanticGapIntelligence: input.includeSemanticGapIntelligence,
  });
  return verificationSemanticGap === null
    ? result
    : { ...result, verificationSemanticGap };
}
