/**
 * tests/launcher/handshakeAuthzCapabilityClaims.test.ts — T-147 bridge
 * proof for the capability-claims store seam.
 *
 * `issueProjectHandshakeViaAdapter` now optionally accepts a
 * `capabilityClaimsStore`. When supplied AND the adapter returns
 * `allow`, the minted `CapabilityEngagementToken` is written under the
 * same opaque token bytes the legacy engagement store uses. This is
 * retrieval option B from T-147 — the legacy binding shape stays
 * untouched (preserving the 28 engagementLifecycle tests).
 */
import { beforeEach, describe, expect, it } from 'vitest';

import { issueProjectHandshakeViaAdapter } from '../../src/hoplon/launcher/handshakeAuthz.js';
import {
  createInMemoryEngagementStore,
  __resetEngagementStoresForTests,
} from '../../src/hoplon/launcher/handshake.js';
import { createInMemoryCapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../src/hoplon/authorization/authorizationAdapter.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';

const FIXED_NOW = new Date('2026-05-03T08:00:00.000Z');
const FIXED_TOKEN = 'token-' + 'x'.repeat(50);
const FIXED_NONCE = 'n'.repeat(32);
const FIXED_TOKEN_ID = 'tk_t147_' + 'a'.repeat(20);

function makeFolderPolicy(): FolderPolicy {
  return {
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [{ folder: 'src', access: 'read_write' }],
    principals: [{ principalId: 'agent-a', kind: 'agent' }],
  };
}

class StaticAllowAdapter implements AuthorizationAdapter {
  evaluateAccess(): Promise<HoplonAuthorizationDecision> {
    return Promise.resolve({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: {
        read: { paths: ['src/**'], branches: ['main'] },
        write: { paths: ['src/**'], branches: ['main'] },
      },
      expiresInSeconds: 60,
      decisionId: 'decision-stub',
      policyVersion: 'v-stub',
    });
  }
}

class DenyAdapter implements AuthorizationAdapter {
  evaluateAccess(_req: HoplonAuthorizationRequest): Promise<HoplonAuthorizationDecision> {
    return Promise.resolve({
      outcome: 'deny',
      reason: 'static deny',
      decisionId: 'd1',
      policyVersion: 'v1',
    });
  }
}

describe('handshakeAuthz — capability-claims store bridge (T-147)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('writes the capability token to the claims store on allow', async () => {
    const registry = createProjectRegistry();
    registry.register({
      projectId: 'p1',
      fsRoot: '/tmp/hoplon-t147-fsroot',
      policy: { folderPolicy: makeFolderPolicy() },
    });
    const store = createInMemoryEngagementStore();
    const claims = createInMemoryCapabilityClaimsStore();

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src/hoplon' },
      {
        registry,
        store,
        adapter: new StaticAllowAdapter(),
        capabilityClaimsStore: claims,
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN,
        randomNonce: () => FIXED_NONCE,
        generateTokenId: () => FIXED_TOKEN_ID,
        sessionId: 'sess-t147',
        taskId: 'task-t147',
      },
    );

    expect(result.kind).toBe('allow');

    // The claims store is keyed by the same opaque token bytes the
    // engagement store uses (option B of T-147 retrieval).
    const claim = claims.get(FIXED_TOKEN);
    expect(claim).not.toBeNull();
    expect(claim?.tokenId).toBe(FIXED_TOKEN_ID);
    expect(claim?.capabilities.write?.paths).toEqual(['src/**']);
    expect(claim?.policy.decisionId).toBe('decision-stub');
  });

  it('does NOT write to the claims store when option is not supplied (no regression)', async () => {
    const registry = createProjectRegistry();
    registry.register({
      projectId: 'p1',
      fsRoot: '/tmp/hoplon-t147-fsroot',
      policy: { folderPolicy: makeFolderPolicy() },
    });
    const store = createInMemoryEngagementStore();
    const claims = createInMemoryCapabilityClaimsStore();

    await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src/hoplon' },
      {
        registry,
        store,
        adapter: new StaticAllowAdapter(),
        // capabilityClaimsStore intentionally omitted
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN,
        randomNonce: () => FIXED_NONCE,
        generateTokenId: () => FIXED_TOKEN_ID,
      },
    );

    expect(claims.get(FIXED_TOKEN)).toBeNull();
  });

  it('does NOT write to the claims store on deny (no token minted)', async () => {
    const registry = createProjectRegistry();
    registry.register({
      projectId: 'p1',
      fsRoot: '/tmp/hoplon-t147-fsroot',
      policy: { folderPolicy: makeFolderPolicy() },
    });
    const store = createInMemoryEngagementStore();
    const claims = createInMemoryCapabilityClaimsStore();

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: 'p1', folder: 'src/hoplon' },
      {
        registry,
        store,
        adapter: new DenyAdapter(),
        capabilityClaimsStore: claims,
        clock: () => FIXED_NOW,
        randomToken: () => FIXED_TOKEN,
        randomNonce: () => FIXED_NONCE,
        generateTokenId: () => FIXED_TOKEN_ID,
      },
    );

    expect(result.kind).toBe('deny');
    expect(claims.get(FIXED_TOKEN)).toBeNull();
  });
});
