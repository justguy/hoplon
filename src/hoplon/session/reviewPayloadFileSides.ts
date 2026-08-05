/** Resolve preview/post-edit file sides for the review payload composer. */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type {
  ReviewChangeKindCounts,
  ReviewPayloadNote,
} from '../contracts/reviewPayload.js';
import { ProposedChangeResolutionError, resolveProposedChange } from '../util/resolveProposedChange.js';
import { SessionError } from './errors.js';
import type { ApplyEditsChangeKindCounts, SessionState } from './types.js';
import type { BuildSessionReviewPayloadInput } from './reviewPayload.js';

interface FileSides {
  before: Uint8Array | null;
  after: Uint8Array | null;
}

export async function gatherFileSides(
  input: BuildSessionReviewPayloadInput,
  notes: ReviewPayloadNote[],
): Promise<{
  filesInReview: string[];
  byFile: Map<string, FileSides>;
  markEditedBeforeBytesUnavailable: boolean;
}> {
  const fs = input.fs;
  if (fs === null) {
    throw new SessionError({
      kind: 'missing_prerequisite',
      from: input.state,
      attempted: 'getReviewPayload',
      detail: 'review payload requires an fs adapter to read before/after bytes',
      details: {
        recoveryClass: 'check_prerequisites',
        prerequisite: 'fs',
      },
    });
  }
  const byFile = new Map<string, FileSides>();

  if (input.phase === 'preview') {
    const changes = input.proposedChanges ?? [];
    const intermediates = new Map<string, Uint8Array | null>();
    const originals = new Map<string, Uint8Array | null>();
    const fileOrder: string[] = [];
    for (const [changeIndex, change] of changes.entries()) {
      if (!intermediates.has(change.file)) {
        const original = await safeRead(fs, change.file);
        originals.set(change.file, original);
        intermediates.set(change.file, original);
        fileOrder.push(change.file);
      }
      try {
        const resolved = await resolveProposedChange(change, {
          currentBytes: intermediates.get(change.file) ?? null,
          codeIntelligence: input.codeIntelligence,
          signal: input.signal,
        });
        intermediates.set(change.file, resolved.bytes);
      } catch (err) {
        throw toReviewPayloadSessionError(
          err,
          input.state,
          changeIndex,
        );
      }
    }
    notes.push('preview_before_bytes_read_from_disk');
    for (const path of fileOrder) {
      byFile.set(path, {
        before: originals.get(path) ?? null,
        after: intermediates.get(path) ?? null,
      });
    }
    return {
      filesInReview: fileOrder,
      byFile,
      markEditedBeforeBytesUnavailable: false,
    };
  }

  // post-edit
  //
  // Snapshotted fallback: the session reached post-edit review while still in
  // `snapshotted` state — no `applyEdits` / `markEdited` transition was ever
  // recorded, so `changedFiles` is empty. Instead of returning an empty review
  // (which surfaces to a consumer as "EMPTY files" → rejection loop), audit the
  // real on-disk files in the contracted writable scope. before-bytes are not
  // retained in this state, so each file is reviewed as full-content
  // (before=null), and an explicit note tells the consumer what happened.
  if (input.state === 'snapshotted') {
    const scope = [...(input.snapshotScopePaths ?? [])].sort();
    const seen = new Set<string>();
    const filesInReview: string[] = [];
    for (const path of scope) {
      if (seen.has(path)) continue;
      seen.add(path);
      const after = await safeRead(fs, path);
      if (after === null) continue; // not materialized on disk → not a real edit
      byFile.set(path, { before: null, after });
      filesInReview.push(path);
    }
    notes.push(
      filesInReview.length === 0
        ? 'snapshotted_review_no_files_on_disk'
        : 'snapshotted_review_scope_fallback',
    );
    return {
      filesInReview,
      byFile,
      markEditedBeforeBytesUnavailable: false,
    };
  }

  const changed = [...input.changedFiles];
  changed.sort();
  if (changed.length === 0) {
    return {
      filesInReview: [],
      byFile,
      markEditedBeforeBytesUnavailable: false,
    };
  }
  for (const path of changed) {
    const after = await safeRead(fs, path);
    const before =
      input.capturedBeforeBytes !== null
        ? input.capturedBeforeBytes.get(path) ?? null
        : null;
    byFile.set(path, { before, after });
  }
  const markEditedBeforeBytesUnavailable =
    input.capturedBeforeBytes === null && changed.length > 0;
  if (markEditedBeforeBytesUnavailable) {
    notes.push('markEdited_before_bytes_unavailable');
  }
  return {
    filesInReview: changed,
    byFile,
    markEditedBeforeBytesUnavailable,
  };
}

async function safeRead(
  fs: HoplonFsAdapter,
  path: string,
): Promise<Uint8Array | null> {
  const stat = await fs.stat(path);
  if (!stat.exists || !stat.isFile) return null;
  return await fs.read(path);
}

export function mirrorCounts(
  counts: ApplyEditsChangeKindCounts | null,
): ReviewChangeKindCounts | null {
  if (counts === null) return null;
  return {
    full_file: counts.full_file,
    patch: counts.patch,
    structural: counts.structural,
  };
}

// ---------------------------------------------------------------------------
// Relevant-tests oracle pane

function toReviewPayloadSessionError(
  err: unknown,
  fromState: SessionState,
  failedChangeIndex: number,
): unknown {
  if (!(err instanceof ProposedChangeResolutionError)) {
    return err;
  }
  const kind =
    err.kind === 'missing_code_intelligence'
      ? 'missing_prerequisite'
      : err.kind;
  return new SessionError({
    kind,
    from: fromState,
    attempted: 'getReviewPayload',
    detail:
      err.kind === 'missing_code_intelligence'
        ? `${err.detail}; none was injected at session construction`
        : err.detail,
    details: {
      recoveryClass:
        err.kind === 'patch_not_applicable'
          ? 'refresh_and_recompute'
          : err.kind === 'target_not_resolved'
            ? 'refresh_symbols_and_retarget'
            : 'check_prerequisites',
      file: err.details.file,
      changeKind: err.details.changeKind,
      failedChangeIndex,
      ...(err.kind === 'missing_code_intelligence'
        ? { prerequisite: 'codeIntelligence' }
        : {}),
      ...(err.details.failedHunkIndex !== undefined
        ? { failedHunkIndex: err.details.failedHunkIndex }
        : {}),
      ...(err.details.requestedSymbol !== undefined
        ? { requestedSymbol: err.details.requestedSymbol }
        : {}),
    },
  });
}
