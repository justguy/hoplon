import type { HoplonEngine } from '../engine/types.js';
import type { WritableManifest } from '../contracts/manifest.js';
import type { RepairContext } from '../contracts/repairContext.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { LockProvider } from '../adapters/lock.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { TraceStore } from '../adapters/traceStore.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { QuickEditResult } from './quickEdit.js';
import type {
  TargetFirstScopedEditRequest,
  TargetFirstScopedEditResult,
} from '../contracts/targetFirstScopedEdit.js';
import type { ProposedChange } from '../contracts/requests.js';
import type { HoplonEditSession } from './types.js';
import type { SessionStagingOptions } from './stagingStore.js';

export type SessionId = string;

/**
 * Creator identity recorded on strict/engaged session starts (hcr-004).
 * Mirrors the verified engagement context of the caller that created the
 * session; strict transports compare every subsequent session-scoped call
 * against it. Absent on non-strict/local starts — the registry itself
 * never enforces ownership, it only records it.
 */
export interface SessionOwner {
  /** Engagement principal; null mirrors a principal-agnostic binding. */
  readonly principalId: string | null;
  /** Canonical project-relative engagement folder ('' = project root). */
  readonly folder: string;
}

/** Metadata tracked by the registry in addition to the session itself. */
export interface RegisteredSessionInfo {
  sessionId: SessionId;
  projectId: string;
  runId: string;
  correlationId: string;
  /** ms since epoch when the session was created. */
  createdAtMs: number;
  /** ms since epoch of the last registry get() (monotonic per-access). */
  lastAccessedAtMs: number;
  /** Strict-mode creator identity; absent for non-strict/local sessions. */
  owner?: SessionOwner;
}

export interface RegisteredSessionEntry extends RegisteredSessionInfo {
  session: HoplonEditSession;
}

export interface StartSessionOptions {
  manifest: WritableManifest;
  /**
   * Optional correlation id override. Defaults to the manifest's own
   * correlationId (matches `createHoplonEditSession`).
   */
  correlationId?: string;
  /** Optional explicit sessionId override — primarily for deterministic tests. */
  sessionId?: SessionId;
  /**
   * Optional repair context from a prior failed-audit session (t-070).
   * Forwarded verbatim to `createHoplonEditSession`; the registry itself
   * never mutates or aggregates repair contexts.
   */
  priorRepairContext?: RepairContext;
  /**
   * Optional creator identity (hcr-004). Strict transports derive this from
   * the verified engagement context on `start`; the registry records it
   * verbatim so strict session-scoped calls can be owner-checked.
   */
  owner?: SessionOwner;
}

/**
 * Options accepted by the registry-level `quickEdit` entry point (t-079).
 * Mirrors `StartSessionOptions` plus the quick-edit orchestration fields.
 * The registry forwards engine + adapter seams exactly the way `start()`
 * does so the wrapper inherits the same supervised posture.
 */
export interface RegistryQuickEditOptions {
  manifest: WritableManifest;
  /** Defaults to `'applyEdits'`. */
  editMode?: 'applyEdits' | 'markEdited';
  proposedChanges?: readonly ProposedChange[];
  markEditedFiles?: readonly string[];
  correlationId?: string;
  sessionId?: SessionId;
  priorRepairContext?: RepairContext;
  /** Default `true`. */
  revertOnBlock?: boolean;
  /** Default `true`. */
  extractRollbackTemplateOnBlock?: boolean;
}

export interface RegistryTargetFirstScopedEditOptions {
  request: TargetFirstScopedEditRequest;
}

export interface SessionRegistry {
  /** Create a fresh session, register it, and return its entry. */
  start(opts: StartSessionOptions): RegisteredSessionEntry | Promise<RegisteredSessionEntry>;
  /**
   * Look up a session by id. Updates `lastAccessedAtMs` on every call so
   * the idle sweep reflects real transport activity, not construction time.
   * Returns null when the id is unknown or already evicted.
   */
  get(sessionId: SessionId): RegisteredSessionEntry | null;
  /**
   * Close the underlying session and evict it from the registry. Safe to
   * call on an unknown id — returns false rather than throwing so transport
   * handlers can stay idempotent over close.
   */
  close(sessionId: SessionId): boolean;
  /** Snapshot of the current registered sessions (excluding the session objects). */
  list(): readonly RegisteredSessionInfo[];
  /** Current entry count. O(1) — convenience for inspection / tests. */
  size(): number;
  /**
   * Close and evict every live session. Also cancels any scheduled idle sweep
   * so the registry can be garbage-collected. Idempotent.
   */
  dispose(): void;
  /**
   * Run the idle sweep immediately against the current clock. Exposed for
   * tests that want deterministic eviction without wall-clock waits.
   */
  sweepIdle(): readonly SessionId[];
  /**
   * Drive a single-shot supervised quick edit (t-079) against a fresh
   * session constructed from the registry's engine + forwarded adapters.
   * The wrapper runs the full ordered loop (preflight → createSnapshot →
   * applyEdits | markEdited → audit → [revert → extractRollbackTemplate
   * on audit BLOCK] → close) and returns a discriminated-union result.
   * The session is always closed before this call returns; no entry is
   * left in the registry map.
   */
  quickEdit(opts: RegistryQuickEditOptions): Promise<QuickEditResult>;
  /**
   * Draft or run a target-first scoped edit over the existing quickEdit path.
   * Preview mode never writes. Apply mode requires an accepted manifest in
   * the request and delegates to quickEdit rather than adding a write path.
   */
  targetFirstScopedEdit(
    opts: RegistryTargetFirstScopedEditOptions,
  ): Promise<TargetFirstScopedEditResult>;
}

export interface SessionRegistryOptions {
  /**
   * The engine the registry hands to every session it starts. Injected by
   * the launcher — the registry never constructs an engine itself.
   */
  engine: HoplonEngine;
  /**
   * Optional Hoplon filesystem adapter forwarded to every session the
   * registry starts. Enables the Hoplon-applied write path (t-063) on
   * packaged transport; when omitted, sessions can still be driven via
   * `markEdited` but `applyEdits` will throw. The launcher constructs this
   * adapter rooted at the same workspace root the engine reads from.
   */
  fs?: HoplonFsAdapter;
  /**
   * Optional code-intelligence adapter (t-071). Forwarded to every session
   * the registry starts so `structural` ProposedChange variants can resolve
   * their target symbols through deterministic Tree-sitter structure on the
   * packaged surfaces. Omit when structural variants are not expected — the
   * default full-file and patch variants do not consult it.
   */
  codeIntelligence?: CodeIntelligenceAdapter;
  /**
   * Optional session-owned lock provider (t-066). Forwarded to every
   * session the registry starts so `applyEdits` on the packaged MCP / HTTP
   * surfaces can acquire AST-node-scoped locks around the supervised
   * write path. The launcher constructs a single shared in-process lock
   * provider per registry so overlapping structural writers across
   * registry-managed sessions actually serialize on the same key space.
   */
  lockProvider?: LockProvider;
  /**
   * Optional staging ceilings forwarded to every constructed session. The
   * registry always creates one aggregate budget and shares it across every
   * session it starts; omitted fields preserve the shipped numeric defaults.
   * Advanced hosts may inject an already-shared `aggregateBudget`.
   */
  staging?: SessionStagingOptions;
  /**
   * Optional host-owned behavior test runner adapter (t-067). Forwarded to
   * every session the registry starts so `session.verifyBehavior()` has a
   * runner on the packaged transport. When omitted, `verifyBehavior`
   * returns the honest `UNAVAILABLE / no_runner` response rather than
   * fabricating a pass.
   */
  behaviorTestRunner?: BehaviorTestRunnerAdapter;
  /**
   * Optional durable trace store (t-068). Forwarded to every registry-backed
   * session so packaged `start()` / `quickEdit()` preserve the same
   * observability contract as direct `createHoplonEditSession(...)` calls.
   * When omitted, trace writes remain an honest no-op.
   */
  traceStore?: TraceStore;
  /**
   * Engine version reported into trace ProofBundle rows when `traceStore` is
   * present. Defaults downstream to `'0.0.0'`; the launcher or embedding host
   * should inject the package version when it has one.
   */
  engineVersion?: string;
  /**
   * t-081 — Optional versioning adapter forwarded to every session the
   * registry starts so `session.getSnapshotEvidence(...)` has a bounded,
   * snapshot-scoped git-evidence surface on the packaged transport. When
   * omitted, the session-level method surfaces
   * `SessionError({ kind: 'missing_prerequisite' })` with
   * `prerequisite: 'versioning'` instead of fabricating evidence.
   */
  versioning?: VersioningAdapter;
  /**
   * t-081 — Optional snapshot store forwarded alongside `versioning` so
   * evidence composition can verify `projectId` / `runId` scoping against
   * authoritative rows.
   */
  snapshotStore?: SnapshotStore;
  /**
   * t-081 — Optional Hoplon-internal git repo dir forwarded to every
   * session the registry starts so evidence composition reads bytes from
   * the same object store the engine commits into. Required alongside
   * `versioning` + `snapshotStore` for the evidence surface to succeed.
   */
  gitRepoDir?: string;
  /**
   * hcr-009 — The revert allowlist the registry's engine was configured
   * with (`HoplonEngineConfig.revertAllowlist`); forwarded to every session
   * so derived audit coverage excludes exactly the trees revert leaves
   * alone. Omit when the engine runs the factory default allowlist.
   */
  revertAllowlist?: readonly string[];
  /**
   * Optional project root forwarded to sessions (and on to the behavior
   * runner). When omitted, sessions receive `null` and the behavior runner
   * gets an empty string in `BehaviorTestRunRequest.projectRoot`.
   */
  projectRoot?: string;
  /** Optional structure-only event emitter forwarded to every session. */
  emitter?: HoplonEmitter;
  /** Engine id for session events before createSnapshot yields a SnapshotRef. */
  engineId?: string;
  /**
   * Optional idle TTL in milliseconds. When set, sessions that have not been
   * `get`-accessed for this interval are closed and evicted on the periodic
   * sweep.
   */
  idleTtlMs?: number;
  /**
   * Optional periodic sweep interval. Defaults to `idleTtlMs` when `idleTtlMs`
   * is set and this is omitted. Ignored when `idleTtlMs` is not set.
   */
  sweepIntervalMs?: number;
  /**
   * Clock seam for deterministic tests. Defaults to `Date.now`.
   */
  now?: () => number;
  /**
   * Scheduler seams for deterministic tests. Default to `setInterval` /
   * `clearInterval`. Accept both Node and DOM shapes by returning unknown.
   */
  setIntervalImpl?: (fn: () => void, intervalMs: number) => unknown;
  clearIntervalImpl?: (handle: unknown) => void;
}
