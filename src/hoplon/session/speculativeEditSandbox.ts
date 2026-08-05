/**
 * session/speculativeEditSandbox.ts — t-127 session-level A/B edit sandbox.
 *
 * Hosts provide one isolated session option set per candidate. This composer
 * drives each candidate through `quickEdit`, cleans up the sandbox in a
 * `finally` path, and adopts only the selected candidate through `quickEdit`
 * on the active workspace after a caller-supplied active-ref check.
 */

import type { CreateHoplonEditSessionOptions } from './types.js';
import { quickEdit, type QuickEditResult } from './quickEdit.js';
import type {
  SpeculativeCandidateEvaluation,
  SpeculativeEditAdoption,
  SpeculativeEditCandidate,
  SpeculativeEditSandboxOutcome,
  SpeculativeEditSandboxResult,
} from '../contracts/speculativeEditSandbox.js';

export interface SpeculativeCandidateSandbox {
  readonly sandboxId?: string;
  readonly transcriptRef?: string;
  readonly sessionOptions: CreateHoplonEditSessionOptions;
  readonly cleanup?: () => Promise<void> | void;
}

export interface ComposeSpeculativeEditSandboxInput {
  readonly candidates: readonly SpeculativeEditCandidate[];
  readonly activeBaseRef: string;
  readonly correlationId: string;
  readonly now: () => number;
  readonly createCandidateSandbox: (
    candidate: SpeculativeEditCandidate,
    context: { readonly candidateIndex: number; readonly signal?: AbortSignal },
  ) => Promise<SpeculativeCandidateSandbox> | SpeculativeCandidateSandbox;
  readonly adoptWinner?: boolean;
  readonly activeSessionOptions?: CreateHoplonEditSessionOptions;
  readonly readActiveWorkspaceRef?: () => Promise<string> | string;
  readonly signal?: AbortSignal;
}

export async function composeSpeculativeEditSandbox(
  input: ComposeSpeculativeEditSandboxInput,
): Promise<SpeculativeEditSandboxResult> {
  assertInput(input);

  const evaluations: SpeculativeCandidateEvaluation[] = [];
  for (let index = 0; index < input.candidates.length; index += 1) {
    const candidate = input.candidates[index];
    if (candidate === undefined) {
      throw new Error(`candidate index ${index} is missing`);
    }
    evaluations.push(await evaluateCandidate(input, candidate, index));
  }

  const selectedCandidateId = selectFirstPassingCandidate(evaluations);
  const selected =
    selectedCandidateId === null
      ? null
      : input.candidates.find((c) => c.candidateId === selectedCandidateId) ?? null;

  const adoption = await adoptSelectedCandidate(input, selected);
  const outcome = deriveOutcome({ selectedCandidateId, adoption });

  return {
    version: 1,
    mechanism: 'isolated_session_sandbox',
    selectionStrategy: 'first_pass_in_input_order',
    activeBaseRef: input.activeBaseRef,
    outcome,
    selectedCandidateId,
    candidates: evaluations,
    adoption,
    correlationId: input.correlationId,
    generatedAt: new Date(input.now()).toISOString(),
  };
}

function assertInput(input: ComposeSpeculativeEditSandboxInput): void {
  if (input.candidates.length === 0) {
    throw new Error('speculative edit sandbox requires at least one candidate');
  }
  const ids = new Set<string>();
  for (const candidate of input.candidates) {
    if (candidate.candidateId.length === 0) {
      throw new Error('candidateId must be non-empty');
    }
    if (candidate.proposedChanges.length === 0) {
      throw new Error(`candidate ${candidate.candidateId} has no proposed changes`);
    }
    if (ids.has(candidate.candidateId)) {
      throw new Error(`duplicate candidateId: ${candidate.candidateId}`);
    }
    ids.add(candidate.candidateId);
  }
  if (input.adoptWinner === true) {
    if (input.activeSessionOptions === undefined) {
      throw new Error('activeSessionOptions is required when adoptWinner=true');
    }
    if (input.readActiveWorkspaceRef === undefined) {
      throw new Error('readActiveWorkspaceRef is required when adoptWinner=true');
    }
  }
}

async function evaluateCandidate(
  input: ComposeSpeculativeEditSandboxInput,
  candidate: SpeculativeEditCandidate,
  candidateIndex: number,
): Promise<SpeculativeCandidateEvaluation> {
  let sandbox: SpeculativeCandidateSandbox | null = null;
  let result: QuickEditResult | null = null;
  let error: unknown;
  try {
    sandbox = await input.createCandidateSandbox(candidate, {
      candidateIndex,
      ...(input.signal !== undefined ? { signal: input.signal } : {}),
    });
    result = await quickEdit({
      ...sandbox.sessionOptions,
      proposedChanges: candidate.proposedChanges,
    });
  } catch (err) {
    error = err;
  }

  const cleanup = await cleanupSandbox(sandbox);
  const evaluation = summarizeCandidate(candidate, sandbox, result, error);
  const cleanupFailed = cleanup.status === 'FAILED';
  return {
    ...evaluation,
    eligibleForAdoption: evaluation.outcome === 'pass' && !cleanupFailed,
    cleanupStatus: cleanup.status,
    ...(cleanup.error !== undefined ? { cleanupError: cleanup.error } : {}),
  };
}

async function cleanupSandbox(
  sandbox: SpeculativeCandidateSandbox | null,
): Promise<{ status: 'CLEANED' | 'FAILED' | 'NOT_APPLICABLE'; error?: unknown }> {
  if (!sandbox?.cleanup) return { status: 'NOT_APPLICABLE' };
  try {
    await sandbox.cleanup();
    return { status: 'CLEANED' };
  } catch (err) {
    return { status: 'FAILED', error: err };
  }
}

function summarizeCandidate(
  candidate: SpeculativeEditCandidate,
  sandbox: SpeculativeCandidateSandbox | null,
  result: QuickEditResult | null,
  error: unknown,
): Omit<
  SpeculativeCandidateEvaluation,
  'eligibleForAdoption' | 'cleanupStatus' | 'cleanupError'
> {
  if (result === null) {
    return {
      candidateId: candidate.candidateId,
      outcome: 'failed',
      sessionId: null,
      snapshotRefId: null,
      changedFiles: [],
      auditStatus: null,
      phase: 'setup',
      sandboxId: sandbox?.sandboxId ?? null,
      transcriptRef: sandbox?.transcriptRef ?? null,
      ...(error !== undefined ? { error } : {}),
    };
  }

  return {
    candidateId: candidate.candidateId,
    outcome: result.outcome,
    sessionId: result.sessionId,
    snapshotRefId: result.snapshotRef?.id ?? null,
    changedFiles: [...result.changedFiles],
    auditStatus: auditStatusOf(result),
    phase: 'phase' in result ? result.phase : null,
    sandboxId: sandbox?.sandboxId ?? null,
    transcriptRef: sandbox?.transcriptRef ?? null,
    ...(result.outcome === 'failed' ? { error: result.error } : {}),
  };
}

function selectFirstPassingCandidate(
  evaluations: readonly SpeculativeCandidateEvaluation[],
): string | null {
  for (const evaluation of evaluations) {
    if (evaluation.eligibleForAdoption) return evaluation.candidateId;
  }
  return null;
}

async function adoptSelectedCandidate(
  input: ComposeSpeculativeEditSandboxInput,
  selected: SpeculativeEditCandidate | null,
): Promise<SpeculativeEditAdoption> {
  if (selected === null) {
    return baseAdoption(input, 'NOT_ATTEMPTED', null, null);
  }
  if (input.adoptWinner !== true) {
    return baseAdoption(input, 'NOT_REQUESTED', selected.candidateId, null);
  }

  let activeRef: string;
  try {
    activeRef = await input.readActiveWorkspaceRef!();
  } catch (err) {
    return {
      ...baseAdoption(input, 'FAILED', selected.candidateId, null),
      phase: 'activeRef',
      error: err,
    };
  }
  if (activeRef !== input.activeBaseRef) {
    return baseAdoption(input, 'CONFLICT', selected.candidateId, activeRef);
  }

  let result: QuickEditResult;
  try {
    result = await quickEdit({
      ...input.activeSessionOptions!,
      proposedChanges: selected.proposedChanges,
    });
  } catch (err) {
    return {
      ...baseAdoption(input, 'FAILED', selected.candidateId, activeRef),
      phase: 'adopt',
      error: err,
    };
  }
  const adopted = result.outcome === 'pass';
  return {
    status: adopted ? 'ADOPTED' : 'FAILED',
    candidateId: selected.candidateId,
    activeBaseRef: input.activeBaseRef,
    activeRefAtAdoption: activeRef,
    sessionId: result.sessionId,
    snapshotRefId: result.snapshotRef?.id ?? null,
    changedFiles: [...result.changedFiles],
    auditStatus: auditStatusOf(result),
    phase: 'phase' in result ? result.phase : null,
    ...(result.outcome === 'failed' ? { error: result.error } : {}),
  };
}

function auditStatusOf(result: QuickEditResult): 'PASS' | 'BLOCK' | null {
  if ('auditResult' in result) return result.auditResult?.status ?? null;
  return null;
}

function baseAdoption(
  input: ComposeSpeculativeEditSandboxInput,
  status: SpeculativeEditAdoption['status'],
  candidateId: string | null,
  activeRef: string | null,
): SpeculativeEditAdoption {
  return {
    status,
    candidateId,
    activeBaseRef: input.activeBaseRef,
    activeRefAtAdoption: activeRef,
    sessionId: null,
    snapshotRefId: null,
    changedFiles: [],
    auditStatus: null,
    phase: null,
  };
}

function deriveOutcome(args: {
  readonly selectedCandidateId: string | null;
  readonly adoption: SpeculativeEditAdoption;
}): SpeculativeEditSandboxOutcome {
  if (args.selectedCandidateId === null) return 'NO_WINNER';
  if (args.adoption.status === 'ADOPTED') return 'ADOPTED';
  if (args.adoption.status === 'CONFLICT') return 'ADOPTION_CONFLICT';
  if (args.adoption.status === 'FAILED') return 'ADOPTION_FAILED';
  return 'WINNER_SELECTED';
}
