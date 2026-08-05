/**
 * launcher/engagementStore.ts — the single server-side binding store
 * that carries issued engagement tokens across the launcher CLI, HTTP,
 * and MCP surfaces.
 *
 * t-083 shipped the in-memory default as part of `handshake.ts`. t-084
 * moves it into its own module and widens the interface with `delete`
 * and `entries` so the shared lifecycle module (`engagementLifecycle`)
 * can implement revocation and expired-state cleanup over one seam
 * without inventing per-transport caches.
 *
 * Nothing in this module inspects the binding beyond storing and
 * enumerating it. TTL resolution and expiry decisions live one level
 * up in `engagementLifecycle` so the store stays pure storage.
 */
import { resolve as resolvePath } from 'node:path';

import type { EngagementTokenBinding } from '../concurrency/projectPolicy.js';

/**
 * Server-side binding store. One shape for every transport. The
 * in-memory default ships with the launcher; a future durable
 * implementation must satisfy the same interface exactly so the
 * lifecycle module keeps working unchanged.
 */
export interface EngagementStore {
  /** Record a newly issued binding under its opaque token. */
  put(token: string, binding: EngagementTokenBinding): void;
  /** Fetch the live binding for a token, or null when absent. */
  get(token: string): EngagementTokenBinding | null;
  /**
   * Remove the binding for `token`. Returns true when a binding was
   * removed. Used by renewal (old token retired once the replacement
   * is written) and by revocation.
   */
  delete(token: string): boolean;
  /**
   * Enumerate live bindings so `pruneExpiredTokens` can inspect
   * `expiresAtIso` without the lifecycle module reaching into the
   * store's internals. Each tuple is a read-only snapshot; callers
   * must never mutate the binding.
   */
  entries(): IterableIterator<readonly [string, EngagementTokenBinding]>;
}

/**
 * Default in-memory engagement store. Bindings live in a plain Map.
 * Not durable across process restarts by design — a durable
 * implementation will replace this behind the same interface without
 * changing the handshake call shape.
 */
export function createInMemoryEngagementStore(): EngagementStore {
  const bindings = new Map<string, EngagementTokenBinding>();
  return {
    put(token, binding) {
      bindings.set(token, binding);
    },
    get(token) {
      return bindings.get(token) ?? null;
    },
    delete(token) {
      return bindings.delete(token);
    },
    entries() {
      return bindings.entries();
    },
  };
}

const engagementStoreByLauncherRoot = new Map<string, EngagementStore>();

/**
 * Launcher-root-scoped singleton engagement store so HTTP, MCP, and CLI
 * surfaces booted against the same root agree on issued bindings. The
 * same handle is returned for lifecycle ops so renewal / revocation /
 * cleanup operate on the same bindings handshake issuance populated.
 */
export function openEngagementStore(launcherRoot: string): EngagementStore {
  const resolvedLauncherRoot = resolvePath(launcherRoot);
  const cached = engagementStoreByLauncherRoot.get(resolvedLauncherRoot);
  if (cached) return cached;
  const store = createInMemoryEngagementStore();
  engagementStoreByLauncherRoot.set(resolvedLauncherRoot, store);
  return store;
}

/**
 * Test-only helper for clearing the per-launcher-root engagement-store
 * cache between runs. Not part of the public lifecycle contract.
 */
export function __resetEngagementStoresForTests(): void {
  engagementStoreByLauncherRoot.clear();
}
