/**
 * authorization/capabilityClaimsStore.ts — sibling capability-claims
 * store for the capability gate (T-147).
 *
 * **Retrieval option B (T-147 decision):** the legacy `EngagementStore`
 * continues to own `EngagementTokenBinding` for the strict engagement
 * gate (preserves the 28 engagementLifecycle tests). A separate
 * sibling store, keyed by the same opaque token bytes, returns the
 * `CapabilityEngagementToken` envelope when an `allow` decision was
 * minted via T-146's adapter path.
 *
 * Why a sibling rather than extending `EngagementStore`:
 *   - Zero migration risk for the existing lifecycle (`verify`, `renew`,
 *     `revoke`, `prune` keep operating on `EngagementTokenBinding`).
 *   - Capability claims are an additive concern — code paths that do
 *     not opt into the capability gate never need to consult this store.
 *   - A future durable implementation (e.g. SQLite) can migrate this
 *     store independently of the legacy lifecycle.
 *
 * Lifecycle:
 *   - `put(token, claims)` — written by `handshakeAuthzMap.finalizeAllow`
 *     when `capabilityMode: 'enforce'` is configured (T-147 plumbing).
 *   - `get(token)` — read by `verifyCapabilityAccess` at the transport
 *     entry-point gate.
 *   - `delete(token)` — called from the engagement-token revocation /
 *     renewal seams to keep both stores in sync. Renewal mints a fresh
 *     capability token and writes it under the new opaque token bytes,
 *     so the old entry is deleted alongside the legacy binding.
 *   - `entries()` — supports the prune sweep so the same `pruneExpiredTokens`
 *     loop in `engagementLifecycle.ts` can also drop capability claims
 *     for expired tokens (T-148 will own that wiring; T-147 only ships
 *     the surface).
 *
 * Architecture rules:
 *   - No ambient state. All deps injected.
 *   - Pure storage; no validation, no clock, no policy logic.
 *   - Named exports only. ES modules. TypeScript strict.
 */
import { resolve as resolvePath } from 'node:path';

import type { CapabilityEngagementToken } from './capabilityToken.js';

/**
 * Sibling store for capability-scoped engagement claims. Keyed by the
 * same opaque token bytes the legacy `EngagementStore` uses, so a
 * caller that already has the opaque token can look up both surfaces.
 */
export interface CapabilityClaimsStore {
  put(token: string, claims: CapabilityEngagementToken): void;
  get(token: string): CapabilityEngagementToken | null;
  delete(token: string): boolean;
  entries(): IterableIterator<readonly [string, CapabilityEngagementToken]>;
  getRuntimeState(token: string): CapabilityRuntimeState | null;
  putRuntimeState(token: string, state: CapabilityRuntimeState): void;
}

export type CapabilityRuntimeState = {
  readonly tokenId: string;
  readonly operationCount: number;
  readonly touchedFiles: readonly string[];
  readonly revokedAtIso?: string;
  readonly quarantinedAtIso?: string;
  readonly revokedGrantIds?: readonly string[];
};

/**
 * Default in-memory capability-claims store. Mirrors
 * `createInMemoryEngagementStore` so test scaffolding stays uniform.
 */
export function createInMemoryCapabilityClaimsStore(): CapabilityClaimsStore {
  const claims = new Map<string, CapabilityEngagementToken>();
  const runtimeState = new Map<string, CapabilityRuntimeState>();
  return {
    put(token, value) {
      claims.set(token, value);
      runtimeState.set(token, initialRuntimeState(value.tokenId));
    },
    get(token) {
      return claims.get(token) ?? null;
    },
    delete(token) {
      const deleted = claims.delete(token);
      runtimeState.delete(token);
      return deleted;
    },
    entries() {
      return claims.entries();
    },
    getRuntimeState(token) {
      return runtimeState.get(token) ?? null;
    },
    putRuntimeState(token, state) {
      runtimeState.set(token, cloneRuntimeState(state));
    },
  };
}

function initialRuntimeState(tokenId: string): CapabilityRuntimeState {
  return {
    tokenId,
    operationCount: 0,
    touchedFiles: [],
  };
}

function cloneRuntimeState(
  state: CapabilityRuntimeState,
): CapabilityRuntimeState {
  return {
    tokenId: state.tokenId,
    operationCount: state.operationCount,
    touchedFiles: [...state.touchedFiles],
    ...(state.revokedAtIso !== undefined
      ? { revokedAtIso: state.revokedAtIso }
      : {}),
    ...(state.quarantinedAtIso !== undefined
      ? { quarantinedAtIso: state.quarantinedAtIso }
      : {}),
    ...(state.revokedGrantIds !== undefined
      ? { revokedGrantIds: [...state.revokedGrantIds] }
      : {}),
  };
}

const claimsByLauncherRoot = new Map<string, CapabilityClaimsStore>();

/**
 * Launcher-root-scoped singleton. Mirrors `openEngagementStore` so
 * HTTP, MCP, and CLI surfaces booted against the same root agree on
 * issued capability claims. Same opaque token resolves on both stores.
 */
export function openCapabilityClaimsStore(
  launcherRoot: string,
): CapabilityClaimsStore {
  const resolved = resolvePath(launcherRoot);
  const cached = claimsByLauncherRoot.get(resolved);
  if (cached) return cached;
  const store = createInMemoryCapabilityClaimsStore();
  claimsByLauncherRoot.set(resolved, store);
  return store;
}

/**
 * Test-only helper for clearing the per-launcher-root capability-claims
 * cache between runs.
 */
export function __resetCapabilityClaimsStoresForTests(): void {
  claimsByLauncherRoot.clear();
}
