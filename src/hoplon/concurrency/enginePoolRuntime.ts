import { randomUUID } from 'node:crypto';
import { EngineError } from '../contracts/errors.js';
import { createHoplonEngine } from '../engine/factory.js';
import type { HoplonEngine } from '../engine/types.js';
import type {
  HoplonEnginePool,
  HoplonEnginePoolOptions,
  HoplonEnginePoolStats,
  PoolEntry,
  Waiter,
} from './enginePoolTypes.js';

/** Create a keyed, reference-counted engine pool with LRU idle eviction. */
export function createHoplonEnginePool(opts: HoplonEnginePoolOptions): HoplonEnginePool {
  const {
    maxConcurrent,
    adapters,
    config,
    acquireTimeoutMs = 30_000,
    engineIdPrefix = 'pool',
  } = opts;
  const poolEngineId = `${engineIdPrefix}-pool`;
  const poolCorrelationId = 'pool';
  const entries = new Map<string, PoolEntry>();
  const waiters: Waiter[] = [];
  const pendingBuilds = new Map<string, Promise<HoplonEngine>>();
  let totalAcquired = 0;
  let totalEvicted = 0;
  let shuttingDown = false;
  let pendingSlots = 0;

  function effectiveSize(): number {
    return entries.size + pendingSlots;
  }

  function findLruIdle(): PoolEntry | undefined {
    let lru: PoolEntry | undefined;
    for (const entry of entries.values()) {
      if (entry.refCount === 0 && (!lru || entry.lastReleaseAt < lru.lastReleaseAt)) lru = entry;
    }
    return lru;
  }

  function evict(entry: PoolEntry): void {
    entries.delete(entry.projectId);
    totalEvicted++;
  }

  function dispatchNextWaiter(): void {
    if (waiters.length === 0) return;
    const next = waiters[0]!;
    const existing = entries.get(next.projectId);
    if (existing) {
      waiters.shift();
      next.cleanup();
      existing.refCount++;
      totalAcquired++;
      next.resolve(existing.engine);
      dispatchNextWaiter();
      return;
    }
    const inFlight = pendingBuilds.get(next.projectId);
    if (inFlight) {
      waiters.shift();
      next.cleanup();
      void settleWaiterFromSharedBuild(next, inFlight);
      dispatchNextWaiter();
      return;
    }
    const hasCapacity = effectiveSize() < maxConcurrent;
    const idleEntry = hasCapacity ? undefined : findLruIdle();
    if (!hasCapacity && !idleEntry) return;
    const waiter = waiters.shift();
    if (!waiter) return;
    waiter.cleanup();
    void buildForWaiter(waiter, idleEntry);
  }

  async function buildForWaiter(waiter: Waiter, idleEntry?: PoolEntry): Promise<void> {
    try {
      waiter.resolve(await buildEngine(waiter.projectId, idleEntry));
    } catch (error) {
      waiter.reject(error);
    }
  }

  async function settleWaiterFromSharedBuild(
    waiter: Waiter,
    inFlight: Promise<HoplonEngine>,
  ): Promise<void> {
    try {
      await inFlight;
      const settled = entries.get(waiter.projectId);
      if (settled) {
        settled.refCount++;
        totalAcquired++;
        waiter.resolve(settled.engine);
        return;
      }
      waiters.unshift(waiter);
      dispatchNextWaiter();
    } catch (error) {
      waiter.reject(error);
    }
  }

  function buildEngine(projectId: string, toEvict?: PoolEntry): Promise<HoplonEngine> {
    const build = buildEngineInner(projectId, toEvict);
    pendingBuilds.set(projectId, build);
    const clear = (): void => {
      if (pendingBuilds.get(projectId) === build) pendingBuilds.delete(projectId);
    };
    build.then(clear, clear);
    return build;
  }

  async function buildEngineInner(projectId: string, toEvict?: PoolEntry): Promise<HoplonEngine> {
    if (toEvict) evict(toEvict);
    pendingSlots++;
    let engine: HoplonEngine;
    try {
      engine = await createHoplonEngine(adapters, {
        ...config,
        engineId: `${engineIdPrefix}-${randomUUID()}`,
      });
    } catch (error) {
      pendingSlots--;
      dispatchNextWaiter();
      throw error;
    }
    pendingSlots--;
    entries.set(projectId, { engine, projectId, refCount: 1, lastReleaseAt: 0 });
    totalAcquired++;
    return engine;
  }

  async function acquire(projectId: string, signal?: AbortSignal): Promise<HoplonEngine> {
    if (shuttingDown) {
      throw new EngineError({
        kind: 'pool_shutting_down',
        engineId: poolEngineId,
        correlationId: poolCorrelationId,
      }, `Engine pool is shutting down — cannot acquire engine for project '${projectId}'.`);
    }
    if (signal?.aborted) throw signal.reason ?? new DOMException('Aborted', 'AbortError');
    const existing = entries.get(projectId);
    if (existing) {
      existing.refCount++;
      totalAcquired++;
      return existing.engine;
    }
    const inFlight = pendingBuilds.get(projectId);
    if (inFlight) {
      await inFlight;
      const settled = entries.get(projectId);
      if (settled) {
        settled.refCount++;
        totalAcquired++;
        return settled.engine;
      }
      return acquire(projectId, signal);
    }
    if (effectiveSize() < maxConcurrent) return buildEngine(projectId);
    const idleEntry = findLruIdle();
    if (idleEntry) return buildEngine(projectId, idleEntry);
    return enqueueAcquire(projectId, signal);
  }

  function enqueueAcquire(projectId: string, signal?: AbortSignal): Promise<HoplonEngine> {
    return new Promise<HoplonEngine>((resolve, reject) => {
      let settled = false;
      const settle = (action: () => void): void => {
        if (settled) return;
        settled = true;
        cleanup();
        action();
      };
      const removeWaiter = (): void => {
        const index = waiters.indexOf(waiter);
        if (index !== -1) waiters.splice(index, 1);
      };
      const timeoutId = setTimeout(() => {
        settle(() => {
          removeWaiter();
          reject(new EngineError({
            kind: 'pool_exhausted',
            engineId: poolEngineId,
            correlationId: poolCorrelationId,
          }, `Pool exhausted (${maxConcurrent} slots busy); timed out after ${acquireTimeoutMs}ms for '${projectId}'.`));
        });
      }, acquireTimeoutMs);
      const onAbort = (): void => {
        settle(() => {
          removeWaiter();
          reject(signal!.reason ?? new DOMException('Aborted', 'AbortError'));
        });
      };
      signal?.addEventListener('abort', onAbort);
      function cleanup(): void {
        clearTimeout(timeoutId);
        signal?.removeEventListener('abort', onAbort);
      }
      const waiter: Waiter = {
        projectId,
        resolve: (engine) => settle(() => resolve(engine)),
        reject: (error) => settle(() => reject(error)),
        cleanup,
      };
      waiters.push(waiter);
    });
  }

  function release(projectId: string): void {
    const entry = entries.get(projectId);
    if (!entry) {
      console.warn(`[HoplonEnginePool] release('${projectId}'): unknown projectId — no-op.`);
      return;
    }
    if (entry.refCount === 0) {
      console.warn(`[HoplonEnginePool] release('${projectId}'): refCount already 0 — no-op.`);
      return;
    }
    entry.refCount--;
    if (entry.refCount === 0) {
      entry.lastReleaseAt = Date.now();
      dispatchNextWaiter();
    }
  }

  function stats(): HoplonEnginePoolStats {
    let busyCount = 0;
    let idleCount = 0;
    for (const entry of entries.values()) {
      if (entry.refCount > 0) busyCount++;
      else idleCount++;
    }
    return {
      maxConcurrent,
      currentSize: entries.size,
      busyCount,
      idleCount,
      totalAcquired,
      totalEvicted,
      projectIds: [...entries.keys()],
    };
  }

  async function shutdown(shutdownOpts?: { drainTimeoutMs?: number }): Promise<void> {
    if (shuttingDown) return;
    shuttingDown = true;
    const drainMs = shutdownOpts?.drainTimeoutMs;
    if (drainMs !== undefined && drainMs > 0) await drainHeldEntries(drainMs);
    const pending = waiters.splice(0);
    for (const waiter of pending) {
      waiter.cleanup();
      waiter.reject(new EngineError({
        kind: 'pool_shutting_down',
        engineId: poolEngineId,
        correlationId: poolCorrelationId,
      }, `Pool shutting down — pending acquire for '${waiter.projectId}' rejected.`));
    }
    entries.clear();
  }

  async function drainHeldEntries(drainMs: number): Promise<void> {
    await new Promise<void>((resolveDrain) => {
      const allIdle = (): boolean => [...entries.values()].every((entry) => entry.refCount === 0);
      if (allIdle()) {
        resolveDrain();
        return;
      }
      const deadline = setTimeout(() => {
        const held = [...entries.values()].filter((entry) => entry.refCount > 0);
        if (held.length > 0) {
          const details = held.map((entry) => `'${entry.projectId}' (refCount=${entry.refCount})`).join(', ');
          console.warn(`[HoplonEnginePool] shutdown drain timeout (${drainMs}ms) — ${held.length} engine(s) still held: ${details}`);
        }
        done();
      }, drainMs);
      const pollId = setInterval(() => { if (allIdle()) done(); }, 10);
      function done(): void {
        clearTimeout(deadline);
        clearInterval(pollId);
        resolveDrain();
      }
    });
  }

  return { acquire, release, stats, shutdown };
}
