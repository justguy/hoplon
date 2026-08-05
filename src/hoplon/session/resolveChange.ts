/**
 * session/resolveChange.ts — resolve a ProposedChange to final UTF-8 bytes.
 *
 * t-071 widens `ProposedChange` from a single full-file shape into an
 * additive union over `full_file`, `patch`, and `structural`. The supervised
 * write path still owns the only `fs.write` call site; this module resolves
 * each variant into the final file bytes *before* the byte-write so one
 * write+rollback path covers every shape.
 *
 * Invariants preserved here:
 *
 *   - Patch anchors must match the current file bytes exactly once. No
 *     line-number fallback, no best-guess match — ambiguous anchors throw a
 *     typed SessionError so the session stays at `snapshotted`.
 *   - Structural targets resolve from deterministic Tree-sitter structure
 *     (top-level symbols). Exact byte offsets stay Hoplon-owned; the caller
 *     never supplies byte ranges.
 *   - Each resolution step is pure byte arithmetic against the *current*
 *     intermediate bytes, so ordered multi-hunk edits against the same file
 *     compose naturally.
 */

import type { ProposedChange } from '../contracts/requests.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import {
  ProposedChangeResolutionError,
  resolveProposedChange,
  type ProposedChangeKind,
  type ResolvedProposedChange,
} from '../util/resolveProposedChange.js';
import { SessionError } from './errors.js';

export type ResolvedChangeKind = ProposedChangeKind;
export type ResolvedChange = ResolvedProposedChange;

export interface ResolveChangeContext {
  /** Current file bytes, or null when the file does not yet exist. */
  currentBytes: Uint8Array | null;
  /**
   * Tree-sitter / LSP adapter. Required when resolving a `structural` change;
   * ignored for `full_file` and `patch` variants.
   */
  codeIntelligence: CodeIntelligenceAdapter | null;
  /** Current session state. Used for SessionError `from` field. */
  fromState: string;
  /** Stable index of this change in the submitted proposedChanges array. */
  changeIndex: number;
}

export async function resolveChange(
  change: ProposedChange,
  ctx: ResolveChangeContext,
): Promise<ResolvedChange> {
  try {
    return await resolveProposedChange(change, {
      currentBytes: ctx.currentBytes,
      codeIntelligence: ctx.codeIntelligence,
    });
  } catch (err) {
    if (err instanceof ProposedChangeResolutionError) {
      const kind =
        err.kind === 'missing_code_intelligence'
          ? 'missing_prerequisite'
          : err.kind;
      throw new SessionError({
        kind,
        from: ctx.fromState,
        attempted: 'applyEdits',
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
          failedChangeIndex: ctx.changeIndex,
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
    throw err;
  }
}
