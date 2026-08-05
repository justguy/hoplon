/**
 * errors.ts — HoplonError base class and four typed subclasses.
 *
 * The error hierarchy is structured around **caller responses**, not
 * implementation details. Each class maps to exactly one correct caller
 * behavior (halt / escalate / retry-fresh / hard-reject).
 *
 * Every throw site uses one of the four typed subclasses with a closed `kind`
 * literal union. If a host sees a raw Error, it is a Hoplon bug.
 *
 * No retry policy — Hoplon never retries (invariant H4).
 *
 * ## Sentinel values for pre-scope errors
 *
 * Errors thrown before the engine is fully constructed (e.g. during
 * `createHoplonEngine` validation, or from utilities called before engine
 * identity is established) use the following sentinel values:
 *
 * - `engineId: 'validator'` — for errors from validation utilities
 *   (`validateCorrelationId`, `validateRunId`, `canonicalizePath`), which are
 *   called before an engine is in scope.
 * - `engineId: (candidateId || 'local-0')` + `correlationId: 'factory'` — for
 *   errors thrown from `createHoplonEngine` during adapter validation, where
 *   no caller-supplied correlationId exists.
 *
 * Once the engine is running, every operation threads the caller's real
 * `correlationId` (invariant H11).
 */

// ---------------------------------------------------------------------------
// HoplonError — base class
// ---------------------------------------------------------------------------

export interface HoplonErrorOptions {
  readonly kind: string;
  readonly engineId: string;
  readonly correlationId: string;
  readonly cause?: unknown;
}

export class HoplonError extends Error {
  readonly kind: string;
  readonly engineId: string;
  readonly correlationId: string;
  override readonly cause: unknown;

  constructor(
    message: string,
    { kind, engineId, correlationId, cause }: HoplonErrorOptions,
  ) {
    super(message);
    this.name = 'HoplonError';
    this.kind = kind;
    this.engineId = engineId;
    this.correlationId = correlationId;
    this.cause = cause;
  }
}

// ---------------------------------------------------------------------------
// EngineError — engine init or invariant failure → caller: halt + alert
// ---------------------------------------------------------------------------

export type EngineErrorKind =
  | 'missing_adapter'
  | 'not_implemented'
  | 'wasm_load_failed'
  | 'grammar_not_registered'
  | 'grammars_dir_missing'
  | 'config_invalid'
  | 'remote_not_supported'
  | 'reconcile_failed'
  | 'project_engine_build_failed'
  // Phase 2 W4 additions (engine pool lifecycle):
  | 'pool_exhausted'
  | 'pool_shutting_down';

export interface EngineErrorOptions {
  readonly kind: EngineErrorKind;
  readonly engineId: string;
  readonly correlationId: string;
  readonly cause?: unknown;
}

/**
 * Thrown when the engine itself is in an unrecoverable state.
 * Caller response: halt + alert. Retrying will not help.
 */
export class EngineError extends HoplonError {
  override readonly kind: EngineErrorKind;

  constructor({ kind, engineId, correlationId, cause }: EngineErrorOptions, message?: string) {
    super(message ?? `Hoplon engine error: ${kind}`, {
      kind,
      engineId,
      correlationId,
      cause,
    });
    this.name = 'EngineError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// AdapterError — runtime adapter failure → caller: escalate
// ---------------------------------------------------------------------------

export type AdapterErrorKind =
  | 'fs_read_failed'
  | 'fs_write_failed'
  | 'git_commit_failed'
  | 'git_checkout_failed'
  | 'git_read_failed'
  | 'snapshot_store_write_failed'
  | 'snapshot_store_read_failed'
  | 'lock_acquire_failed'
  | 'parser_init_failed'
  // Phase 3 remote backup additions:
  | 'remote_push_failed'
  | 'remote_fetch_failed';

export interface AdapterErrorOptions {
  readonly kind: AdapterErrorKind;
  readonly engineId: string;
  readonly correlationId: string;
  readonly cause?: unknown;
}

/**
 * Thrown when an injected adapter fails at runtime.
 * Caller response: escalate. May be transient; idempotent operations may retry.
 */
export class AdapterError extends HoplonError {
  override readonly kind: AdapterErrorKind;

  constructor({ kind, engineId, correlationId, cause }: AdapterErrorOptions, message?: string) {
    super(message ?? `Hoplon adapter error: ${kind}`, {
      kind,
      engineId,
      correlationId,
      cause,
    });
    this.name = 'AdapterError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// SemanticError — bad cross-operation state → caller: retry with fresh state
// ---------------------------------------------------------------------------

export type SemanticErrorKind =
  | 'snapshot_missing'
  | 'manifest_version_mismatch'
  | 'audit_version_mismatch'
  | 'project_id_mismatch'
  | 'run_id_mismatch'
  | 'snapshot_not_committed'
  | 'unknown_project'
  | 'no_active_project';

export interface SemanticErrorOptions {
  readonly kind: SemanticErrorKind;
  readonly engineId: string;
  readonly correlationId: string;
  readonly cause?: unknown;
}

/**
 * Thrown when cross-operation state is inconsistent (e.g. snapshot not found,
 * schema version mismatch, cross-project replay detected).
 * Caller response: re-fetch snapshot or re-derive context. Do NOT retry blind.
 */
export class SemanticError extends HoplonError {
  override readonly kind: SemanticErrorKind;

  constructor({ kind, engineId, correlationId, cause }: SemanticErrorOptions, message?: string) {
    super(message ?? `Hoplon semantic error: ${kind}`, {
      kind,
      engineId,
      correlationId,
      cause,
    });
    this.name = 'SemanticError';
    this.kind = kind;
  }
}

// ---------------------------------------------------------------------------
// ValidationError — invalid input shape → caller: hard reject
// ---------------------------------------------------------------------------

export type ValidationErrorKind =
  | 'invalid_manifest'
  | 'invalid_scope'
  | 'invalid_path'
  | 'path_traversal'
  | 'manifest_too_large'
  | 'file_too_large_for_manifest'
  | 'invalid_correlation_id'
  | 'invalid_run_id'
  /** Two mutually exclusive adapter slots were both provided (e.g. versioning + gitAdapter). */
  | 'conflicting_adapters'
  /**
   * t-026: `dlpPolicyMode === 'block'` and the DLP adapter returned at least
   * one finding. Thrown before Phase B git commit; no snapshot is written.
   */
  | 'dlp_policy_block';

export interface ValidationErrorOptions {
  readonly kind: ValidationErrorKind;
  readonly engineId: string;
  readonly correlationId: string;
  readonly cause?: unknown;
}

/**
 * Thrown when request input is invalid (schema validation, path traversal,
 * size limits). Caller response: hard reject. Do NOT retry — input is wrong.
 */
export class ValidationError extends HoplonError {
  override readonly kind: ValidationErrorKind;

  constructor(
    { kind, engineId, correlationId, cause }: ValidationErrorOptions,
    message?: string,
  ) {
    super(message ?? `Hoplon validation error: ${kind}`, {
      kind,
      engineId,
      correlationId,
      cause,
    });
    this.name = 'ValidationError';
    this.kind = kind;
  }
}
