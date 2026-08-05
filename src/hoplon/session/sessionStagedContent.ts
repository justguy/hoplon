import type { ProposedChange } from '../contracts/requests.js';
import { SessionError } from './errors.js';
import type { SessionRuntime } from './sessionRuntime.js';
import type { StageContentInput, StageContentResult } from './types.js';

type StagedAttempt = 'applyEdits' | 'dryRun' | 'getReviewPayload';

export function stageContent(
  runtime: SessionRuntime,
  input: StageContentInput,
): StageContentResult {
  if (runtime.state === 'closed') {
    throw new SessionError({
      kind: 'session_closed',
      from: runtime.state,
      attempted: 'stageContent',
      detail: 'session is already closed; staged content cannot be appended',
      details: { recoveryClass: 'restart_session' },
    });
  }
  return runtime.stagingStore.stage(input, runtime.state);
}

function decodeStagedText(
  runtime: SessionRuntime,
  bytes: Uint8Array,
  change: ProposedChange,
  attempted: StagedAttempt,
  changeIndex: number,
): string {
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: runtime.state,
      attempted,
      detail: `staged body for "${change.file}" is not valid UTF-8 text`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'stagedContent.utf8',
        failedChangeIndex: changeIndex,
        file: change.file,
        changeKind:
          'kind' in change && change.kind === 'structural'
            ? 'structural'
            : 'full_file',
      },
    });
  }
}

export function hydrateStagedContent(
  runtime: SessionRuntime,
  proposedChanges: readonly ProposedChange[],
  attempted: StagedAttempt,
): {
  proposedChanges: readonly ProposedChange[];
  stagedKeys: readonly string[];
} {
  if (!proposedChanges.some(
    (change) => 'stagedContent' in change && change.stagedContent !== undefined,
  )) {
    return { proposedChanges, stagedKeys: [] };
  }
  const stagedKeys = new Set<string>();
  const hydrated = proposedChanges.map((change, changeIndex): ProposedChange => {
    if (!('stagedContent' in change) || change.stagedContent === undefined) {
      return change;
    }
    const bytes = runtime.stagingStore.read(
      change.stagedContent,
      runtime.state,
      changeIndex,
      attempted,
    );
    stagedKeys.add(change.stagedContent.stagingKey);
    const content = decodeStagedText(
      runtime,
      bytes,
      change,
      attempted,
      changeIndex,
    );
    if ('kind' in change && change.kind === 'structural') {
      return {
        kind: 'structural',
        file: change.file,
        target: change.target,
        content,
      };
    }
    const rest: { kind?: 'full_file'; file: string; content: string } = {
      file: change.file,
      content,
    };
    if ('kind' in change && change.kind === 'full_file') {
      rest.kind = 'full_file';
    }
    return rest as ProposedChange;
  });
  return {
    proposedChanges: hydrated,
    stagedKeys: Array.from(stagedKeys).sort(),
  };
}
