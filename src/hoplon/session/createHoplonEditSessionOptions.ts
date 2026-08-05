/** Construction options for a supervised edit session. */

import type { WritableManifest } from '../contracts/manifest.js';
import type { RepairContext } from '../contracts/repairContext.js';
import type { PostEditPolicyScanner } from '../contracts/postEditPolicy.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { LockProvider } from '../adapters/lock.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { TraceStore } from '../adapters/traceStore.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { SessionStagingOptions } from './stagingStore.js';

export interface CreateHoplonEditSessionOptions {
  engine: import('../engine/types.js').HoplonEngine;
  manifest: WritableManifest;
  /**
   * Correlation id threaded through every engine call. Defaults to the
   * manifest's own correlationId.
   */
  correlationId?: string;
  /**
   * Optional session id override for tests/tracing. Defaults to a
   * generated UUIDv4-like identifier.
   */
  sessionId?: string;
  /**
   * Clock seam for deterministic tests. Defaults to Date.now.
   */
  now?: () => number;
  /** Optional structure-only event emitter for session lifecycle telemetry. */
  emitter?: HoplonEmitter;
  /** Engine id used before createSnapshot returns its authoritative ref. */
  engineId?: string;
  /**
   * Optional Hoplon filesystem adapter used by `applyEdits` to write the
   * edited bytes. When omitted, `applyEdits` throws and the caller must
   * fall back to `markEdited` (host-owned write).
   *
   * The adapter root must resolve to the same filesystem location the
   * engine reads from — the launcher constructs both against the same
   * workspace root so subsequent `audit`/`revert` calls observe the bytes
   * the session wrote.
   */
  fs?: HoplonFsAdapter;
  /**
   * Optional code-intelligence adapter (t-071). Required only when callers
   * submit `structural` ProposedChange variants through `applyEdits`; the
   * default full-file and patch variants do not consult it. When absent, a
   * structural variant surfaces as `SessionError({ kind: 'missing_prerequisite' })`
   * without touching the filesystem.
   */
  codeIntelligence?: CodeIntelligenceAdapter;
  /**
   * Optional session-owned lock provider (t-066). When supplied, the
   * supervised `applyEdits` write path acquires an overlap-aware AST-node
   * lock set for structural `ProposedChange` variants plus per-file locks
   * for `full_file` / `patch` variants. Pure structural files re-use the
   * existing per-file key only at the final commit phase so disjoint
   * same-file structural sessions can re-resolve against the latest bytes
   * without taking a whole-file key in the initial lock plan. The launcher constructs one shared
   * `AsyncMutex`-backed provider per session registry so every session
   * started through packaged MCP / HTTP gets node-scoped locks without the
   * host having to wire anything. When omitted, the write path degrades to
   * lock-free behavior — the session still works in-process but concurrent
   * same-file writers no longer serialize.
   *
   * Raw lock acquire / release is intentionally *not* exposed to the LLM:
   * lock lifecycle is owned entirely by the session and keyed from
   * Hoplon-resolved AST byte ranges, never from agent-supplied bytes.
   */
  lockProvider?: LockProvider;
  /**
   * Optional validated ceilings for the session-owned in-memory staging
   * store. Omitted fields retain the shipped staging constants. A custom
   * aggregate budget can be injected when multiple directly constructed
   * sessions must share one process-memory ceiling.
   */
  staging?: SessionStagingOptions;
  /**
   * Optional host-owned behavior test runner adapter (t-067). When supplied,
   * `session.verifyBehavior()` invokes the adapter over the test selection
   * derived from `getRelevantTests`. When omitted, `verifyBehavior` returns
   * `status: 'UNAVAILABLE', outcome: 'NOT_RUN', unavailabilityReason: 'no_runner'`
   * instead of fabricating a pass. Test execution is host-owned: the
   * adapter chooses the framework, sandbox, and budget; Hoplon only wraps
   * the outcome into an advisory envelope.
   */
  behaviorTestRunner?: BehaviorTestRunnerAdapter;
  /**
   * Optional advisory scanner used only when review payload callers pass
   * `{ includePostEditPolicyScan: true }`. The scanner receives proposed or
   * applied bytes and must return redacted findings. Findings never alter
   * session state, audit PASS/BLOCK, or revert eligibility.
   */
  postEditPolicyScanner?: PostEditPolicyScanner;
  /**
   * Filesystem root forwarded to the behavior test runner's
   * `BehaviorTestRunRequest.projectRoot`. When omitted, the runner receives
   * an empty string and the adapter is expected to fall back to its own
   * default. The session does not currently derive a project root from the
   * injected fs adapter.
   */
  projectRoot?: string;
  /**
   * Optional semantic-search worktree scope for live-session overlays. When
   * present, dryRun/applyEdits/markEdited refreshes publish and clear under
   * `projectId + worktreeId + sessionId` so a reused session id cannot leak
   * overlay rows across worktrees.
   */
  worktreeId?: string;
  /**
   * Optional durable trace store (t-068). When supplied, the session
   * writes ExecutionTrace / Attempt / ProofBundle / DecisionProvenance
   * records on construction, on each audit, and on close. Trace writes
   * are observability-only and never block the session's enforcement
   * semantics; a failed trace write does not alter PASS/BLOCK behavior.
   */
  traceStore?: TraceStore;
  /**
   * Engine version reported into ProofBundle records. Defaults to '0.0.0'
   * when omitted. The launcher typically injects the package version.
   */
  engineVersion?: string;
  /**
   * Optional repair context from a prior failed-audit session (t-070).
   * When supplied, the session:
   *   - seeds `attemptCounter` so the next audit() advances to
   *     `priorRepairContext.nextAttempt.attemptNumber`
   *   - echoes the DTO through `SessionSnapshot.priorRepairContext`
   *
   * This is the only cross-session linkage the session layer is aware of.
   * It does not replay prior session state, does not reuse the prior
   * snapshotRef, and does not share the prior session's history — the
   * retry session is still a fresh, ordered-loop self-edit session; the
   * linkage is observational, not mutable shared state.
   */
  priorRepairContext?: RepairContext;
  /**
   * t-081 — Optional versioning adapter forwarded to
   * `session.getSnapshotEvidence(...)`. When omitted, the snapshot-
   * evidence method throws `SessionError({ kind: 'missing_prerequisite' })`
   * with `prerequisite: 'versioning'` so a host that never wired an
   * adapter does not receive fabricated evidence. Paired with
   * `snapshotStore` + `gitRepoDir`; all three must be present for
   * evidence composition to succeed.
   */
  versioning?: VersioningAdapter;
  /**
   * t-081 — Optional snapshot store forwarded to
   * `session.getSnapshotEvidence(...)`. Required alongside
   * `versioning` for evidence composition; enforces project / run
   * scoping and surfaces provenance metadata from authoritative rows.
   */
  snapshotStore?: SnapshotStore;
  /**
   * t-081 — Optional Hoplon-internal git repo dir used by evidence
   * composition. Required alongside `versioning` + `snapshotStore`. When
   * constructed through the registry, the launcher supplies the same
   * `gitRepoDir` the engine was wired with so evidence derives bytes
   * from the identical object store.
   */
  gitRepoDir?: string;
  /**
   * hcr-009 — The revert allowlist the session's engine was configured with
   * (`HoplonEngineConfig.revertAllowlist`). Audit-coverage discovery excludes
   * exactly these trees so derived coverage and `revertUncontracted` share a
   * single source of truth: a tree revert is configured to leave alone is
   * never fed to `auditDiff` as an uncontracted post-snapshot discovery.
   * When omitted, discovery uses the engine factory's default allowlist
   * (`.git/**`, `node_modules/**`, `.hoplon/**`).
   */
  revertAllowlist?: readonly string[];
}
