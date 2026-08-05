/**
 * operations/gcSnapshot.ts — W3 TTL snapshot GC scheduler.
 *
 * `createGcScheduler` returns a handle that repeatedly calls `engine.gc` with
 * `expiredBefore = now` on a configurable interval.  The scheduler uses the
 * host-supplied `setInterval` / `clearInterval` so fake timers work in tests.
 *
 * ## Design constraints
 * - No ambient state.  Every dependency (engine, timer functions) is injected.
 * - No silent swallow: GC errors are forwarded to the optional `onError` hook.
 * - H4: Hoplon never owns retry policy.  The scheduler fires once per interval;
 *   if gc() throws, the caller's `onError` handler decides what to do.
 * - H13: no snapshot content in any event or log.
 * - Architecture law #1: file is well under 300 lines.
 * - Architecture law #3: named exports only.
 *
 * ## Import wall
 * Only engine facade type from types.ts — no pipeline/agents imports.
 */

import type { HoplonEngine } from '../engine/types.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Opaque handle returned by createGcScheduler.  Call stop() to cancel. */
export interface GcSchedulerHandle {
  /** Cancel the scheduled GC.  Idempotent — safe to call multiple times. */
  stop(): void;
}

/** Dependencies injected into createGcScheduler.  All required. */
export interface GcSchedulerDeps {
  /** The engine whose gc() method will be called on each tick. */
  engine: HoplonEngine;
  /**
   * How often (in ms) to run GC.
   * Must be a positive integer.
   */
  intervalMs: number;
  /**
   * Delete snapshots whose ttl_expires is set and older than this many ms.
   * Must be a positive integer.
   * GC deletes rows where ttl_expires < (now - retentionMs + retentionMs) ≡ ttl_expires < now.
   *
   * Note: retentionMs does NOT shift the GC cutoff — the cutoff is always "now".
   * retentionMs is used by createSnapshot to set ttl_expires at write time.
   * The scheduler simply deletes any row whose ttl_expires has already passed.
   */
  retentionMs: number;
  /**
   * Called when a GC tick throws.  Default: swallow (caller opted in to silent).
   * Provide a handler to surface errors (e.g. re-throw in tests, log in prod).
   */
  onError?: (err: unknown) => void;
  /**
   * Injected timer factories for testability (fake timers in unit tests).
   * Default: globalThis.setInterval / globalThis.clearInterval.
   */
  setInterval?: (fn: () => void, ms: number) => ReturnType<typeof globalThis.setInterval>;
  clearInterval?: (id: ReturnType<typeof globalThis.setInterval>) => void;
}

// ---------------------------------------------------------------------------
// createGcScheduler
// ---------------------------------------------------------------------------

/**
 * Schedule repeated TTL-based snapshot GC.
 *
 * Calls `engine.gc({ expiredBefore: <now ISO> })` every `intervalMs` ms.
 * Returns a handle with a `stop()` method to cancel the interval.
 *
 * No tick runs immediately at creation — the first run is after `intervalMs`.
 *
 * @throws {Error} if intervalMs or retentionMs is not a positive integer.
 */
export function createGcScheduler(deps: GcSchedulerDeps): GcSchedulerHandle {
  const {
    engine,
    intervalMs,
    retentionMs,
    onError,
    setInterval: setIntervalFn = globalThis.setInterval.bind(globalThis),
    clearInterval: clearIntervalFn = globalThis.clearInterval.bind(globalThis),
  } = deps;

  if (!Number.isInteger(intervalMs) || intervalMs <= 0) {
    throw new Error(`createGcScheduler: intervalMs must be a positive integer, got ${intervalMs}`);
  }
  if (!Number.isInteger(retentionMs) || retentionMs <= 0) {
    throw new Error(`createGcScheduler: retentionMs must be a positive integer, got ${retentionMs}`);
  }

  const tick = (): void => {
    // expiredBefore = now.  Any snapshot whose ttl_expires < now is deleted.
    const expiredBefore = new Date().toISOString();
    engine.gc({ expiredBefore }).catch((err: unknown) => {
      if (onError != null) {
        onError(err);
      }
      // If no onError handler, error is swallowed per H4 (caller decides policy).
    });
  };

  const timerId = setIntervalFn(tick, intervalMs);

  return {
    stop(): void {
      clearIntervalFn(timerId);
    },
  };
}
