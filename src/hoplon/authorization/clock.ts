/**
 * authorization/clock.ts — minimal injectable clock interface for the
 * dynamic authorization layer (T-145).
 *
 * Architecture rules:
 *   - Pure types and interfaces only. No `Date.now`, `process.hrtime`,
 *     `setTimeout`, or any other ambient time access.
 *   - Implementations must be injected through adapter constructors so
 *     tests can supply deterministic time without monkey-patching.
 *   - Named exports only. ES modules. No `any`.
 */

/**
 * Minimal clock contract used by `OpaAuthorizationAdapter` (and other
 * future authorization adapters) to embed the evaluation timestamp into
 * OPA input deterministically.
 *
 * Returns an ISO 8601 timestamp (UTC, millisecond precision recommended).
 * The adapter calls `nowIso()` exactly once per `evaluateAccess` invocation
 * so that `context.now` is stable for the lifetime of a single decision
 * even if the wall clock advances during sidecar I/O.
 */
export interface Clock {
  nowIso(): string;
}

/**
 * Default `Clock` implementation that reads system time. Adapter callers
 * must explicitly opt into this by passing `systemClock` — it is never the
 * default constructor argument because the adapter takes no defaults that
 * touch ambient state.
 */
export const systemClock: Clock = {
  nowIso(): string {
    return new Date().toISOString();
  },
};
