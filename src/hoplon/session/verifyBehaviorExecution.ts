import type { BehaviorTestRunRequest } from '../adapters/behaviorTestRunner.js';
import {
  createEmptyEvidence,
  createNotRunExitStatus,
} from '../adapters/behaviorTestRunner.js';
import type {
  VerifyBehaviorEvidence,
  VerifyBehaviorExecution,
  VerifyBehaviorNote,
  VerifyBehaviorResult,
  VerifyBehaviorSelection,
} from '../contracts/verifyBehavior.js';
import { buildSelection } from './verifyBehaviorSelection.js';
import {
  assemble,
  buildEmptyExecution,
  buildEmptySelection,
  buildLinkage,
  coerceUnavailability,
  decideOutcome,
  safeDescribeAvailability,
} from './verifyBehaviorSupport.js';
import type { ComposeVerifyBehaviorInput } from './verifyBehaviorTypes.js';

export async function composeVerifyBehaviorResult(
  input: ComposeVerifyBehaviorInput,
): Promise<VerifyBehaviorResult> {
  const notes = new Set<VerifyBehaviorNote>();
  const generatedAt = new Date(input.now()).toISOString();
  const linkage = buildLinkage(input);
  const includeSemanticGapIntelligence =
    input.options.includeSemanticGapIntelligence === true;

  if (input.sessionId === null) notes.add('session_linkage_unavailable');
  if (!input.runner) {
    notes.add('runner_not_injected');
    return assemble({
      status: 'UNAVAILABLE',
      outcome: 'NOT_RUN',
      unavailabilityReason: 'no_runner',
      selection: buildEmptySelection('no_runner'),
      execution: buildEmptyExecution('no behavior test runner injected'),
      evidence: createEmptyEvidence(),
      linkage,
      correlationId: input.correlationId,
      generatedAt,
      notes,
      includeSemanticGapIntelligence,
    });
  }

  const availability = await safeDescribeAvailability(input.runner, input.signal);
  if (!availability.ok) {
    return assemble({
      status: 'UNAVAILABLE',
      outcome: 'NOT_RUN',
      unavailabilityReason: availability.unavailabilityReason,
      selection: buildEmptySelection('runner_unavailable'),
      execution: {
        runnerId: input.runner.id,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        exitStatus: createNotRunExitStatus(
          availability.detail ?? 'runner unavailable',
        ),
        timeoutMs: input.options.timeoutMs ?? null,
        workingDirectory: null,
      },
      evidence: createEmptyEvidence(),
      linkage,
      correlationId: input.correlationId,
      generatedAt,
      notes,
      includeSemanticGapIntelligence,
    });
  }

  const selectionResult = await buildSelection({
    engine: input.engine,
    options: input.options,
    projectId: input.projectId,
    runId: input.runId,
    correlationId: input.correlationId,
    sessionChangedFiles: input.changedFiles,
    signal: input.signal,
    notes,
  });

  if (selectionResult.kind === 'oracle_failure') {
    notes.add('oracle_failure');
    return assemble({
      status: 'UNAVAILABLE',
      outcome: 'NOT_RUN',
      unavailabilityReason: 'oracle_failure',
      selection: {
        strategy: 'none',
        testsExecuted: [],
        oracleResult: null,
        coverageConfidence: 'not_applicable',
        modifiedFilesSource: selectionResult.modifiedFilesSource,
      },
      execution: buildEmptyExecution(
        selectionResult.reasonDetail ?? 'oracle call failed',
      ),
      evidence: createEmptyEvidence(),
      linkage,
      correlationId: input.correlationId,
      generatedAt,
      notes,
      includeSemanticGapIntelligence,
    });
  }

  if (selectionResult.kind === 'not_run') {
    notes.add(selectionResult.note);
    return assemble({
      status: 'UNAVAILABLE',
      outcome: 'NOT_RUN',
      unavailabilityReason: selectionResult.unavailabilityReason,
      selection: {
        strategy: 'none',
        testsExecuted: [],
        oracleResult: selectionResult.oracleResult,
        coverageConfidence: selectionResult.coverageConfidence,
        modifiedFilesSource: selectionResult.modifiedFilesSource,
      },
      execution: buildEmptyExecution(selectionResult.reasonDetail),
      evidence: createEmptyEvidence(),
      linkage,
      correlationId: input.correlationId,
      generatedAt,
      notes,
      includeSemanticGapIntelligence,
    });
  }

  for (const note of selectionResult.notes) notes.add(note);
  const runnerReq: BehaviorTestRunRequest = {
    testFiles: selectionResult.testsExecuted,
    runFullSuite: selectionResult.runFullSuite,
    projectRoot: input.projectRoot,
    correlationId: input.correlationId,
    projectId: input.projectId,
    runId: input.runId,
    ...(input.options.timeoutMs !== undefined
      ? { timeoutMs: input.options.timeoutMs }
      : {}),
    ...(input.options.runnerMeta !== undefined
      ? { meta: input.options.runnerMeta }
      : {}),
  };

  let runOutcome;
  try {
    runOutcome = await input.runner.run(runnerReq, input.signal);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return assemble({
      status: 'DEGRADED',
      outcome: 'NOT_RUN',
      unavailabilityReason: coerceUnavailability(err) ?? 'runner_error',
      selection: {
        strategy: selectionResult.strategy,
        testsExecuted: selectionResult.testsExecuted,
        oracleResult: selectionResult.oracleResult,
        coverageConfidence: selectionResult.coverageConfidence,
        modifiedFilesSource: selectionResult.modifiedFilesSource,
      },
      execution: {
        runnerId: input.runner.id,
        startedAt: null,
        completedAt: null,
        durationMs: null,
        exitStatus:
          err instanceof Error && err.name === 'AbortError'
            ? { kind: 'runner_error', code: null, signal: null, reason: 'aborted' }
            : { kind: 'runner_error', code: null, signal: null, reason: message },
        timeoutMs: input.options.timeoutMs ?? null,
        workingDirectory: null,
      },
      evidence: createEmptyEvidence(),
      linkage,
      correlationId: input.correlationId,
      generatedAt,
      notes,
      includeSemanticGapIntelligence,
    });
  }

  const evidence: VerifyBehaviorEvidence = {
    failingTests: [...runOutcome.failingTests],
    passingTestCount: runOutcome.passingTestCount,
    skippedTestCount: runOutcome.skippedTestCount,
    stdout: runOutcome.stdout,
    stderr: runOutcome.stderr,
    structured: runOutcome.structured,
    truncated: runOutcome.truncated,
  };
  const execution: VerifyBehaviorExecution = {
    runnerId: runOutcome.runnerId,
    startedAt: runOutcome.startedAt,
    completedAt: runOutcome.completedAt,
    durationMs: runOutcome.durationMs,
    exitStatus: runOutcome.exitStatus,
    timeoutMs: input.options.timeoutMs ?? null,
    workingDirectory: runOutcome.workingDirectory,
  };
  const decision = decideOutcome({
    exitStatus: runOutcome.exitStatus,
    failingTestCount: evidence.failingTests.length,
  });
  for (const note of decision.outcomeNotes) notes.add(note);
  const selection: VerifyBehaviorSelection = {
    strategy: selectionResult.strategy,
    testsExecuted: selectionResult.testsExecuted,
    oracleResult: selectionResult.oracleResult,
    coverageConfidence: selectionResult.coverageConfidence,
    modifiedFilesSource: selectionResult.modifiedFilesSource,
  };
  return assemble({
    status: decision.status,
    outcome: decision.outcome,
    unavailabilityReason: decision.unavailabilityReason,
    selection,
    execution,
    evidence,
    linkage,
    correlationId: input.correlationId,
    generatedAt,
    notes,
    includeSemanticGapIntelligence,
  });
}
