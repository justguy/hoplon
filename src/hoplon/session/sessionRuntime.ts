import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { LockProvider } from '../adapters/lock.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { TraceStore } from '../adapters/traceStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { AuditResult } from '../contracts/audit.js';
import type { WritableManifest } from '../contracts/manifest.js';
import type { PostEditPolicyScanner } from '../contracts/postEditPolicy.js';
import type { PreflightResult } from '../contracts/preflight.js';
import type { RepairContext } from '../contracts/repairContext.js';
import type { RevertResult } from '../contracts/revert.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import type { SnapshotRef } from '../contracts/snapshot.js';
import type { VerifyBehaviorResult } from '../contracts/verifyBehavior.js';
import type { HoplonEngine } from '../engine/types.js';
import {
  buildSessionSnapshot,
  cloneValue,
  generateSessionId,
} from './internal.js';
import { createSessionStagingStore } from './stagingStore.js';
import type { SessionStagingStore } from './stagingStore.js';
import { createSessionTelemetry } from './telemetry.js';
import type { SessionTelemetry } from './telemetry.js';
import { createSessionTraceWriter } from './traceWriter.js';
import type { SessionTraceWriter } from './traceWriter.js';
import type {
  ApplyEditsChangeKindCounts,
  CreateHoplonEditSessionOptions,
  DryRunResult,
  SessionSnapshot,
  SessionState,
  SessionTransition,
} from './types.js';

export interface SessionRuntime {
  engine: HoplonEngine;
  manifest: WritableManifest;
  correlationId: string;
  sessionId: string;
  now: () => number;
  fs: HoplonFsAdapter | null;
  codeIntelligence: CodeIntelligenceAdapter | null;
  behaviorTestRunner: BehaviorTestRunnerAdapter | null;
  postEditPolicyScanner: PostEditPolicyScanner | null;
  lockProvider: LockProvider | null;
  projectRoot: string | null;
  worktreeId: string | null;
  traceStore: TraceStore | null;
  engineVersion: string;
  versioningAdapter: VersioningAdapter | null;
  snapshotStoreAdapter: SnapshotStore | null;
  gitRepoDir: string | null;
  revertAllowlist: readonly string[] | null;
  priorRepairContext: RepairContext | null;
  state: SessionState;
  snapshotRef: SnapshotRef | null;
  changedFiles: readonly string[];
  lastPreflightResult: PreflightResult | null;
  lastDryRunResult: DryRunResult | null;
  lastAuditResult: AuditResult | null;
  capturedBeforeBytes: ReadonlyMap<string, Uint8Array | null> | null;
  lastApplyEditsChangeKindCounts: ApplyEditsChangeKindCounts | null;
  lastAuditTimestampMs: number | null;
  lastRevertResult: RevertResult | null;
  lastRollbackTemplate: RollbackTemplate | null;
  lastVerifyBehaviorResult: VerifyBehaviorResult | null;
  attemptCounter: number;
  traceOpened: boolean;
  traceExecutionId: string | null;
  lastTraceAttemptId: string | null;
  traceEngineId: string;
  sessionStartedAtMs: number;
  history: SessionTransition[];
  sessionTelemetry: SessionTelemetry;
  traceWriter: SessionTraceWriter;
  stagingStore: SessionStagingStore;
}

export function createSessionRuntime(
  opts: CreateHoplonEditSessionOptions,
): SessionRuntime {
  const engine = opts.engine;
  const manifest = cloneValue(opts.manifest);
  const correlationId = opts.correlationId ?? manifest.correlationId;
  const sessionId = opts.sessionId ?? generateSessionId();
  const now = opts.now ?? Date.now;
  const fs = opts.fs ?? null;
  const codeIntelligence = opts.codeIntelligence ?? null;
  const behaviorTestRunner = opts.behaviorTestRunner ?? null;
  const postEditPolicyScanner = opts.postEditPolicyScanner ?? null;
  const lockProvider = opts.lockProvider ?? null;
  const projectRoot = opts.projectRoot ?? null;
  const worktreeId = opts.worktreeId ?? null;
  const traceStore = opts.traceStore ?? null;
  const engineVersion = opts.engineVersion ?? '0.0.0';
  const versioningAdapter = opts.versioning ?? null;
  const snapshotStoreAdapter = opts.snapshotStore ?? null;
  const gitRepoDir = opts.gitRepoDir ?? null;
  const revertAllowlist = opts.revertAllowlist ?? null;
  const priorRepairContext = opts.priorRepairContext
    ? cloneValue(opts.priorRepairContext)
    : null;
  const traceEngineId = opts.engineId ?? 'local-0';
  const sessionStartedAtMs = now();
  const runtime: SessionRuntime = {
    engine,
    manifest,
    correlationId,
    sessionId,
    now,
    fs,
    codeIntelligence,
    behaviorTestRunner,
    postEditPolicyScanner,
    lockProvider,
    projectRoot,
    worktreeId,
    traceStore,
    engineVersion,
    versioningAdapter,
    snapshotStoreAdapter,
    gitRepoDir,
    revertAllowlist,
    priorRepairContext,
    state: 'created',
    snapshotRef: null,
    changedFiles: [],
    lastPreflightResult: null,
    lastDryRunResult: null,
    lastAuditResult: null,
    capturedBeforeBytes: null,
    lastApplyEditsChangeKindCounts: null,
    lastAuditTimestampMs: null,
    lastRevertResult: null,
    lastRollbackTemplate: null,
    lastVerifyBehaviorResult: null,
    attemptCounter: priorRepairContext
      ? priorRepairContext.failedAttempt.attemptNumber
      : 0,
    traceOpened: false,
    traceExecutionId: null,
    lastTraceAttemptId: null,
    traceEngineId,
    sessionStartedAtMs,
    history: [
      {
        op: 'created',
        fromState: 'created',
        toState: 'created',
        timestampMs: sessionStartedAtMs,
      },
    ],
    sessionTelemetry: null as unknown as SessionTelemetry,
    traceWriter: null as unknown as SessionTraceWriter,
    stagingStore: null as unknown as SessionStagingStore,
  };
  runtime.sessionTelemetry = createSessionTelemetry({
    emitter: opts.emitter ?? null,
    getEngineId: () => runtime.traceEngineId,
    projectId: manifest.projectId,
    runId: manifest.runId,
    correlationId: runtime.correlationId,
    now,
  });
  runtime.sessionTelemetry.emitSessionStart();
  resetSessionTraceWriter(runtime);
  runtime.stagingStore = createSessionStagingStore(opts.staging);
  return runtime;
}

export function resetSessionTraceWriter(runtime: SessionRuntime): void {
  runtime.traceWriter = createSessionTraceWriter(runtime.traceStore, {
    sessionId: runtime.sessionId,
    projectId: runtime.manifest.projectId,
    runId: runtime.manifest.runId,
    engineId: runtime.traceEngineId,
    correlationId: runtime.correlationId,
    engineVersion: runtime.engineVersion,
    schemaVersion: 1,
  });
}

export function buildRuntimeSnapshot(runtime: SessionRuntime): SessionSnapshot {
  return buildSessionSnapshot({
    sessionId: runtime.sessionId,
    state: runtime.state,
    manifest: runtime.manifest,
    correlationId: runtime.correlationId,
    snapshotRef: runtime.snapshotRef,
    changedFiles: runtime.changedFiles,
    lastPreflightResult: runtime.lastPreflightResult,
    lastDryRunResult: runtime.lastDryRunResult,
    lastAuditResult: runtime.lastAuditResult,
    lastRevertResult: runtime.lastRevertResult,
    lastRollbackTemplate: runtime.lastRollbackTemplate,
    priorRepairContext: runtime.priorRepairContext,
    nextAttemptNumber: runtime.attemptCounter + 1,
    history: runtime.history,
  });
}
