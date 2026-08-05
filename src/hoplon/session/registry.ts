/**
 * Transport-local registry runtime for Hoplon edit sessions.
 */
import { createHoplonEditSession } from './session.js';
import { quickEdit, type QuickEditOptions } from './quickEdit.js';
import { targetFirstScopedEdit } from './targetFirstScopedEdit.js';
import { createRegistryStagingOptions } from './registryStaging.js';
import type {
  RegisteredSessionEntry,
  RegisteredSessionInfo,
  SessionId,
  SessionRegistry,
  SessionRegistryOptions,
} from './registryTypes.js';

export type * from './registryTypes.js';

/**
 * Build a new session registry. Call this once per transport server; inject
 * the returned registry into the HTTP routes and MCP tool handlers.
 */
export function createSessionRegistry(
  opts: SessionRegistryOptions,
): SessionRegistry {
  const now = opts.now ?? (() => Date.now());
  const setIntervalFn = opts.setIntervalImpl ?? ((fn, ms) => setInterval(fn, ms));
  const clearIntervalFn =
    opts.clearIntervalImpl ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>));
  const staging = createRegistryStagingOptions(opts.staging);

  const entries = new Map<SessionId, RegisteredSessionEntry>();
  let sweepHandle: unknown = null;

  function toInfo(entry: RegisteredSessionEntry): RegisteredSessionInfo {
    return {
      sessionId: entry.sessionId,
      projectId: entry.projectId,
      runId: entry.runId,
      correlationId: entry.correlationId,
      createdAtMs: entry.createdAtMs,
      lastAccessedAtMs: entry.lastAccessedAtMs,
      ...(entry.owner !== undefined ? { owner: entry.owner } : {}),
    };
  }

  function sweepIdle(): readonly SessionId[] {
    if (opts.idleTtlMs === undefined) return [];
    const cutoff = now() - opts.idleTtlMs;
    const evicted: SessionId[] = [];
    for (const [id, entry] of entries) {
      if (entry.lastAccessedAtMs <= cutoff) {
        try {
          entry.session.close();
        } catch {
          // Close is idempotent in the session contract; swallow to keep the
          // sweep pass monotonic. The entry is removed below regardless.
        }
        entries.delete(id);
        evicted.push(id);
      }
    }
    return evicted;
  }

  if (opts.idleTtlMs !== undefined) {
    const sweepInterval = opts.sweepIntervalMs ?? opts.idleTtlMs;
    sweepHandle = setIntervalFn(() => {
      sweepIdle();
    }, sweepInterval);
  }

  return {
    start(startOpts) {
      const nowMs = now();
      const session = createHoplonEditSession({
        engine: opts.engine,
        manifest: startOpts.manifest,
        ...(startOpts.correlationId !== undefined
          ? { correlationId: startOpts.correlationId }
          : {}),
        ...(startOpts.sessionId !== undefined ? { sessionId: startOpts.sessionId } : {}),
        ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
        ...(opts.codeIntelligence !== undefined
          ? { codeIntelligence: opts.codeIntelligence }
          : {}),
        ...(opts.lockProvider !== undefined
          ? { lockProvider: opts.lockProvider }
          : {}),
        ...(staging !== undefined ? { staging } : {}),
        ...(opts.behaviorTestRunner !== undefined
          ? { behaviorTestRunner: opts.behaviorTestRunner }
          : {}),
        ...(opts.traceStore !== undefined ? { traceStore: opts.traceStore } : {}),
        ...(opts.engineVersion !== undefined
          ? { engineVersion: opts.engineVersion }
          : {}),
        ...(opts.projectRoot !== undefined
          ? { projectRoot: opts.projectRoot }
          : {}),
        ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
        ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
        ...(startOpts.priorRepairContext !== undefined
          ? { priorRepairContext: startOpts.priorRepairContext }
          : {}),
        ...(opts.versioning !== undefined ? { versioning: opts.versioning } : {}),
        ...(opts.snapshotStore !== undefined
          ? { snapshotStore: opts.snapshotStore }
          : {}),
        ...(opts.gitRepoDir !== undefined ? { gitRepoDir: opts.gitRepoDir } : {}),
        ...(opts.revertAllowlist !== undefined
          ? { revertAllowlist: opts.revertAllowlist }
          : {}),
        now,
      });
      const entry: RegisteredSessionEntry = {
        sessionId: session.sessionId,
        projectId: startOpts.manifest.projectId,
        runId: startOpts.manifest.runId,
        correlationId: startOpts.correlationId ?? startOpts.manifest.correlationId,
        createdAtMs: nowMs,
        lastAccessedAtMs: nowMs,
        ...(startOpts.owner !== undefined ? { owner: startOpts.owner } : {}),
        session,
      };
      entries.set(entry.sessionId, entry);
      return entry;
    },
    get(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return null;
      entry.lastAccessedAtMs = now();
      return entry;
    },
    close(sessionId) {
      const entry = entries.get(sessionId);
      if (!entry) return false;
      try {
        entry.session.close();
      } catch {
        // Session.close() is idempotent; swallow so the caller always gets
        // "evicted" semantics from a successful registry.close.
      }
      entries.delete(sessionId);
      return true;
    },
    list() {
      return Array.from(entries.values()).map(toInfo);
    },
    size() {
      return entries.size;
    },
    dispose() {
      if (sweepHandle !== null) {
        clearIntervalFn(sweepHandle);
        sweepHandle = null;
      }
      for (const entry of entries.values()) {
        try {
          entry.session.close();
        } catch {
          // swallow — disposal is best-effort.
        }
      }
      entries.clear();
    },
    sweepIdle,
    async quickEdit(quickOpts) {
      const wrapperOpts: QuickEditOptions = {
        engine: opts.engine,
        manifest: quickOpts.manifest,
        ...(quickOpts.correlationId !== undefined
          ? { correlationId: quickOpts.correlationId }
          : {}),
        ...(quickOpts.sessionId !== undefined
          ? { sessionId: quickOpts.sessionId }
          : {}),
        ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
        ...(opts.codeIntelligence !== undefined
          ? { codeIntelligence: opts.codeIntelligence }
          : {}),
        ...(opts.lockProvider !== undefined
          ? { lockProvider: opts.lockProvider }
          : {}),
        ...(staging !== undefined ? { staging } : {}),
        ...(opts.behaviorTestRunner !== undefined
          ? { behaviorTestRunner: opts.behaviorTestRunner }
          : {}),
        ...(opts.traceStore !== undefined ? { traceStore: opts.traceStore } : {}),
        ...(opts.engineVersion !== undefined
          ? { engineVersion: opts.engineVersion }
          : {}),
        ...(opts.projectRoot !== undefined
          ? { projectRoot: opts.projectRoot }
          : {}),
        ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
        ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
        ...(quickOpts.priorRepairContext !== undefined
          ? { priorRepairContext: quickOpts.priorRepairContext }
          : {}),
        now,
        ...(quickOpts.editMode !== undefined
          ? { editMode: quickOpts.editMode }
          : {}),
        ...(quickOpts.proposedChanges !== undefined
          ? { proposedChanges: quickOpts.proposedChanges }
          : {}),
        ...(quickOpts.markEditedFiles !== undefined
          ? { markEditedFiles: quickOpts.markEditedFiles }
          : {}),
        ...(quickOpts.revertOnBlock !== undefined
          ? { revertOnBlock: quickOpts.revertOnBlock }
          : {}),
        ...(quickOpts.extractRollbackTemplateOnBlock !== undefined
          ? {
              extractRollbackTemplateOnBlock:
                quickOpts.extractRollbackTemplateOnBlock,
            }
          : {}),
        ...(opts.versioning !== undefined ? { versioning: opts.versioning } : {}),
        ...(opts.snapshotStore !== undefined
          ? { snapshotStore: opts.snapshotStore }
          : {}),
        ...(opts.gitRepoDir !== undefined ? { gitRepoDir: opts.gitRepoDir } : {}),
        ...(opts.revertAllowlist !== undefined
          ? { revertAllowlist: opts.revertAllowlist }
          : {}),
      };
      return quickEdit(wrapperOpts);
    },
    targetFirstScopedEdit(scopedOpts) {
      return targetFirstScopedEdit({
        engine: opts.engine,
        request: scopedOpts.request,
        root: opts.projectRoot ?? '',
        staging,
        ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
        ...(opts.codeIntelligence !== undefined
          ? { codeIntelligence: opts.codeIntelligence }
          : {}),
        ...(opts.lockProvider !== undefined
          ? { lockProvider: opts.lockProvider }
          : {}),
        ...(opts.behaviorTestRunner !== undefined
          ? { behaviorTestRunner: opts.behaviorTestRunner }
          : {}),
        ...(opts.traceStore !== undefined ? { traceStore: opts.traceStore } : {}),
        ...(opts.versioning !== undefined ? { versioning: opts.versioning } : {}),
        ...(opts.snapshotStore !== undefined
          ? { snapshotStore: opts.snapshotStore }
          : {}),
        ...(opts.gitRepoDir !== undefined ? { gitRepoDir: opts.gitRepoDir } : {}),
        ...(opts.revertAllowlist !== undefined
          ? { revertAllowlist: opts.revertAllowlist }
          : {}),
        ...(opts.projectRoot !== undefined
          ? { projectRoot: opts.projectRoot }
          : {}),
        ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
        ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
        ...(opts.engineVersion !== undefined
          ? { engineVersion: opts.engineVersion }
          : {}),
        now,
      });
    },
  };
}
