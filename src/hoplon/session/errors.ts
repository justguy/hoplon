/**
 * session/errors.ts — SessionError: typed failures for the Hoplon edit
 * session state machine.
 *
 * Shape mirrors the existing HoplonError discriminated-kind pattern but
 * stays local to the session module: SessionError describes *orchestration*
 * failures (wrong-state calls, closed sessions, missing prerequisites).
 * Engine-level failures (AdapterError, ValidationError, EngineError,
 * SemanticError) continue to propagate unchanged from engine operations.
 */

/**
 * Stable session failure kinds surfaced both in-process and over packaged
 * transport.
 *
 * - `patch_not_applicable`: a patch variant's `search` anchor did not match
 *   the current file bytes exactly once (t-071). Thrown before any bytes touch
 *   disk so rollback semantics stay deterministic.
 * - `target_not_resolved`: a structural variant's target symbol could not be
 *   resolved to exactly one top-level symbol in the current file bytes
 *   (t-071). Thrown before any bytes touch disk.
 * - `stage_integrity_mismatch`: the chunked staging sub-protocol (t-076)
 *   rejected a staged body because the seq was out of order, a size ceiling
 *   was exceeded, or the finalized sha256/byteLength did not match the
 *   caller's declaration. Thrown before any bytes touch disk; the staged
 *   entry stays discardable in process memory.
 * - `stale_write`: the supervised write path (t-090) detected an external
 *   writer mutated, created, or deleted one of the touched files between
 *   the moment Hoplon captured the live base bytes (post-lock acquisition,
 *   pre-resolution) and the final flush of the resolved output. The error
 *   is raised before the stale `fs.write` lands; any earlier writes in the
 *   same batch are rolled back to their pre-applyEdits originals so the
 *   session leaves no partial drift behind. Recovery class is
 *   `refresh_and_recompute`: the caller should re-read the live file and
 *   re-derive the proposed change before retrying.
 */
export const SESSION_ERROR_KINDS = [
  'invalid_state_transition',
  'preflight_not_passed',
  'session_closed',
  'missing_prerequisite',
  'patch_not_applicable',
  'target_not_resolved',
  'stage_integrity_mismatch',
  'stale_write',
] as const;

export type SessionErrorKind = (typeof SESSION_ERROR_KINDS)[number];

export const SESSION_RECOVERY_CLASSES = [
  'inspect_state',
  'restart_session',
  'check_prerequisites',
  'refresh_and_recompute',
  'refresh_symbols_and_retarget',
] as const;

export type SessionRecoveryClass = (typeof SESSION_RECOVERY_CLASSES)[number];

/**
 * Sub-kind discriminator for `stale_write` SessionErrors (t-090). Distinguishes
 * the three forms of TOCTOU drift the supervised write path detects between
 * live-base capture and the final flush:
 *
 *   - `bytes_diverged`: the file existed when Hoplon captured the live base
 *     and still exists now, but the live bytes differ from the captured
 *     base (an external writer mutated the file in-place).
 *   - `unexpected_creation`: the file did not exist when Hoplon captured
 *     the live base, but it does now (an external writer created the file
 *     before our flush would have).
 *   - `unexpected_deletion`: the file existed when Hoplon captured the
 *     live base, but it has been removed by an external actor.
 *
 * The error is raised before the stale `fs.write` lands; the caller's
 * recovery story (`refresh_and_recompute`) is identical for all three
 * sub-kinds, but downstream observers (retry harnesses, telemetry) can
 * branch on the discriminator.
 */
export type StaleWriteDriftKind =
  | 'bytes_diverged'
  | 'unexpected_creation'
  | 'unexpected_deletion';

export interface SessionErrorDetails {
  recoveryClass?: SessionRecoveryClass;
  allowedStates?: readonly string[];
  prerequisite?: string;
  file?: string;
  changeKind?: 'full_file' | 'patch' | 'structural';
  failedChangeIndex?: number;
  failedHunkIndex?: number;
  requestedSymbol?: string;
  /** Sub-kind for `stale_write` errors (t-090). */
  driftKind?: StaleWriteDriftKind;
  /**
   * Captured live-base byte length for the touched file at lock-acquisition
   * time. `null` when the file did not exist when the live base was
   * captured (an `unexpected_creation` drift). Surfaced for content-free
   * telemetry; never carries the file bytes themselves.
   */
  byteLengthBefore?: number | null;
  /**
   * Live byte length observed at flush time. `null` when the file was
   * removed before the flush (an `unexpected_deletion` drift). Mirrors the
   * H13 content-free discipline: counts only, no bytes.
   */
  byteLengthLive?: number | null;
}

export interface SessionErrorTransportDetails extends SessionErrorDetails {
  from: string;
  attempted: string;
  detail?: string;
  recoveryClass: SessionRecoveryClass;
}

export function sessionRecoveryClassForKind(
  kind: SessionErrorKind,
): SessionRecoveryClass {
  switch (kind) {
    case 'invalid_state_transition':
    case 'preflight_not_passed':
      return 'inspect_state';
    case 'session_closed':
      return 'restart_session';
    case 'missing_prerequisite':
      return 'check_prerequisites';
    case 'patch_not_applicable':
    case 'stage_integrity_mismatch':
    case 'stale_write':
      return 'refresh_and_recompute';
    case 'target_not_resolved':
      return 'refresh_symbols_and_retarget';
  }
}

export interface SessionErrorPayload {
  kind: SessionErrorKind;
  /** Current session state when the error was raised. */
  from: string;
  /** The operation the caller attempted. */
  attempted: string;
  /** Optional extra detail. Never carries secret material or file content. */
  detail?: string;
  /** Optional machine-readable recovery metadata for transport surfaces. */
  details?: SessionErrorDetails;
  /** Optional transport correlation id when reconstructed remotely. */
  correlationId?: string;
}

export class SessionError extends Error {
  readonly kind: SessionErrorKind;
  readonly from: string;
  readonly attempted: string;
  readonly detail: string | undefined;
  readonly details: SessionErrorDetails | undefined;
  readonly correlationId: string | undefined;

  constructor(payload: SessionErrorPayload, message?: string) {
    super(
      message ??
        `Hoplon session: ${payload.kind} (attempted ${payload.attempted} from ${payload.from}${payload.detail ? `; ${payload.detail}` : ''})`,
    );
    this.name = 'SessionError';
    this.kind = payload.kind;
    this.from = payload.from;
    this.attempted = payload.attempted;
    this.detail = payload.detail;
    this.details = payload.details;
    this.correlationId = payload.correlationId;
  }
}

export function toSessionErrorTransportDetails(
  err: SessionError,
): SessionErrorTransportDetails {
  return {
    from: err.from,
    attempted: err.attempted,
    recoveryClass:
      err.details?.recoveryClass ?? sessionRecoveryClassForKind(err.kind),
    ...(err.detail !== undefined ? { detail: err.detail } : {}),
    ...(err.details ?? {}),
  };
}
