/**
 * tests/transport/capabilityEngagementGate.test.ts — T-147 transport
 * adapter coverage for `verifyCapabilityAccess`.
 *
 * Drives the gate without spinning up an HTTP server: the gate is a
 * pure async helper around the in-memory `CapabilityClaimsStore`. The
 * goal here is to prove the off-by-default contract, the "both gates
 * must pass" invariant, and the typed denial envelope shape T-148 will
 * consume.
 */

import { describe, expect, it } from 'vitest';

import {
  CapabilityDeniedError,
  DEFAULT_CAPABILITY_GATE_MODE,
  verifyCapabilityAccess,
  type CapabilityCheck,
  type CapabilityGateDeps,
} from '../../src/hoplon/transport/capabilityEngagementGate.js';
import {
  createInMemoryCapabilityClaimsStore,
  type CapabilityClaimsStore,
} from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const FUTURE = new Date('2026-05-04T12:00:00.000Z');

const TOKEN = 'opaque-token-bytes';

function makeToken(): CapabilityEngagementToken {
  return Object.freeze({
    token: TOKEN,
    projectId: 'proj-x',
    folder: 'src',
    access: 'read_write' as const,
    principalId: 'agent-a',
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: FUTURE.toISOString(),
    tokenId: 'token-id-1',
    subject: 'agent-a',
    sessionId: 'session-1',
    capabilities: {
      read: { paths: ['src/**'], branches: ['main'] },
      write: {
        paths: ['src/**'],
        branches: ['main'],
        deniedPaths: ['**/.env'],
      },
    },
    policy: {
      engine: 'static',
      source: 'standing_policy' as const,
      decisionId: 'decision-1',
      policyVersion: 'v1',
    },
  }) as CapabilityEngagementToken;
}

function makeTokenWith(
  overrides: Partial<CapabilityEngagementToken>,
): CapabilityEngagementToken {
  return Object.freeze({
    ...makeToken(),
    ...overrides,
  }) as CapabilityEngagementToken;
}

function makeRbaaLimitedToken(limits: {
  maxOperations?: number;
  maxFilesTouched?: number;
}): CapabilityEngagementToken {
  const base = makeToken();
  return makeTokenWith({
    policy: {
      ...base.policy,
      engine: 'opa',
      grantIds: ['grant-1'],
      rbaa: {
        schemaVersion: 1,
        limits: { expiresInSeconds: 300, ...limits },
        risk: {
          evaluationId: 'risk-1',
          band: 'R1_GUARDED',
          scoreBucket: '20-39',
          autonomyTier: 'A2_SCOPED_EDITOR',
          controls: ['max_edit_operations', 'max_files_touched'],
          topFactors: [],
        },
      },
    },
  });
}

function makeStoreWithToken(token: CapabilityEngagementToken = makeToken()): CapabilityClaimsStore {
  const store = createInMemoryCapabilityClaimsStore();
  store.put(TOKEN, token);
  return store;
}

function makeStoreWithoutRuntimeState(): CapabilityClaimsStore {
  const store = createInMemoryCapabilityClaimsStore();
  store.put(TOKEN, makeRbaaLimitedToken({ maxOperations: 1 }));
  return {
    put: store.put,
    get: store.get,
    delete: store.delete,
    entries: store.entries,
    getRuntimeState: () => null,
    putRuntimeState: store.putRuntimeState,
  };
}

function makeCheck(overrides: Partial<CapabilityCheck> = {}): CapabilityCheck {
  return {
    engagement: {
      token: TOKEN,
      folder: 'src',
      principalId: 'agent-a',
    },
    correlationId: 'corr-1',
    capability: 'read',
    projectId: 'proj-x',
    branch: 'main',
    path: 'src/foo.ts',
    sessionId: 'session-1',
    ...overrides,
  };
}

describe('DEFAULT_CAPABILITY_GATE_MODE', () => {
  it('is `off` (T-147 advisory-only default)', () => {
    expect(DEFAULT_CAPABILITY_GATE_MODE).toBe('off');
  });
});

describe('verifyCapabilityAccess — off mode (default)', () => {
  it('is a no-op when deps.mode is undefined', async () => {
    await expect(
      verifyCapabilityAccess({}, makeCheck()),
    ).resolves.toBeUndefined();
  });

  it('is a no-op when deps.mode === "off" even with a wired store', async () => {
    const store = makeStoreWithToken();
    await expect(
      verifyCapabilityAccess(
        { claimsStore: store, mode: 'off', clock: () => NOW },
        makeCheck({
          engagement: undefined,
          capability: 'write',
          path: 'src/.env',
        }),
      ),
    ).resolves.toBeUndefined();
  });
});

describe('verifyCapabilityAccess — enforce mode', () => {
  function deps(store: CapabilityClaimsStore | undefined): CapabilityGateDeps {
    return {
      ...(store ? { claimsStore: store } : {}),
      mode: 'enforce',
      clock: () => NOW,
    };
  }

  it('fails closed when no claims store is wired (configuration bug)', async () => {
    await expect(
      verifyCapabilityAccess(deps(undefined), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'invalid_token',
      statusCode: 503,
      capability: 'read',
    });
  });

  it('fails closed when no engagement on request', async () => {
    const store = makeStoreWithToken();
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck({ engagement: undefined })),
    ).rejects.toMatchObject({
      kind: 'reauth_required',
      reason: 'invalid_token',
      statusCode: 401,
    });
  });

  it('fails closed when token is unknown', async () => {
    const store = makeStoreWithToken();
    await expect(
      verifyCapabilityAccess(
        deps(store),
        makeCheck({
          engagement: { token: 'unknown', folder: 'src', principalId: 'agent-a' },
        }),
      ),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
  });

  it('passes when capability + branch + path all match', async () => {
    const store = makeStoreWithToken();
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).resolves.toBeUndefined();
  });

  it('denies when capability is missing on token', async () => {
    const store = makeStoreWithToken();
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck({ capability: 'snapshot' })),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'capability_missing',
      capability: 'snapshot',
      statusCode: 403,
    });
  });

  it('denies when path matches deniedPaths even if it matches paths', async () => {
    const store = makeStoreWithToken();
    await expect(
      verifyCapabilityAccess(
        deps(store),
        makeCheck({ capability: 'write', path: 'src/.env' }),
      ),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'denied_path_match',
    });
  });

  it('denial envelope carries audit-ready fields for T-148', async () => {
    const store = makeStoreWithToken();
    let caught: unknown;
    try {
      await verifyCapabilityAccess(
        deps(store),
        makeCheck({ capability: 'read', branch: 'feature/x' }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapabilityDeniedError);
    const denied = caught as CapabilityDeniedError;
    expect(denied.decisionId).toBe('decision-1');
    expect(denied.policyVersion).toBe('v1');
    expect(denied.tokenId).toBe('token-id-1');
    expect(denied.capability).toBe('read');
    expect(denied.branch).toBe('feature/x');
    expect(denied.path).toBe('src/foo.ts');
    expect(denied.reason).toBe('branch_mismatch');
  });

  it('reauth_required when token expired', async () => {
    const store = createInMemoryCapabilityClaimsStore();
    const expiredToken: CapabilityEngagementToken = Object.freeze({
      ...makeToken(),
      expiresAtIso: '2026-05-01T00:00:00.000Z',
    }) as CapabilityEngagementToken;
    store.put(TOKEN, expiredToken);
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'reauth_required',
      reason: 'token_expired',
      statusCode: 401,
    });
  });

  it('increments RBAA operation counters and reauths after maxOperations', async () => {
    const store = makeStoreWithToken(makeRbaaLimitedToken({ maxOperations: 1 }));
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).resolves.toBeUndefined();
    expect(store.getRuntimeState(TOKEN)?.operationCount).toBe(1);
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'reauth_required',
      reason: 'operation_limit_exceeded',
      statusCode: 401,
    });
    expect(store.getRuntimeState(TOKEN)?.operationCount).toBe(1);
  });

  it('tracks distinct touched files and reauths after maxFilesTouched', async () => {
    const store = makeStoreWithToken(makeRbaaLimitedToken({ maxFilesTouched: 1 }));
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck({ path: 'src/foo.ts' })),
    ).resolves.toBeUndefined();
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck({ path: 'src/foo.ts' })),
    ).resolves.toBeUndefined();
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck({ path: 'src/bar.ts' })),
    ).rejects.toMatchObject({
      kind: 'reauth_required',
      reason: 'file_touch_limit_exceeded',
      statusCode: 401,
    });
    expect(store.getRuntimeState(TOKEN)?.touchedFiles).toEqual(['src/foo.ts']);
  });

  it('fails closed when opt-in runtime state is missing', async () => {
    await expect(
      verifyCapabilityAccess(deps(makeStoreWithoutRuntimeState()), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'reauth_required',
      reason: 'missing_runtime_state',
      statusCode: 401,
    });
  });

  it('fails closed when token carries a malformed runtime limit', async () => {
    const malformed = makeTokenWith({
      capabilities: {
        read: {
          paths: ['src/**'],
          branches: ['main'],
          maxOperations: 0,
        },
      },
    });
    await expect(
      verifyCapabilityAccess(deps(makeStoreWithToken(malformed)), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'invalid_token',
      statusCode: 403,
      field: 'capabilities.read.maxOperations',
    });
  });

  it('denies revoked tokens from runtime state', async () => {
    const store = makeStoreWithToken(makeRbaaLimitedToken({ maxOperations: 5 }));
    store.putRuntimeState(TOKEN, {
      tokenId: 'token-id-1',
      operationCount: 0,
      touchedFiles: [],
      revokedAtIso: '2026-05-03T12:00:00.000Z',
    });
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'token_revoked',
      statusCode: 403,
    });
  });

  it('denies revoked grants from runtime state', async () => {
    const store = makeStoreWithToken(makeRbaaLimitedToken({ maxOperations: 5 }));
    store.putRuntimeState(TOKEN, {
      tokenId: 'token-id-1',
      operationCount: 0,
      touchedFiles: [],
      revokedGrantIds: ['grant-1'],
    });
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'grant_revoked',
      statusCode: 403,
    });
  });

  it('denies quarantined tokens from runtime state', async () => {
    const store = makeStoreWithToken(makeRbaaLimitedToken({ maxOperations: 5 }));
    store.putRuntimeState(TOKEN, {
      tokenId: 'token-id-1',
      operationCount: 0,
      touchedFiles: [],
      quarantinedAtIso: '2026-05-03T12:00:00.000Z',
    });
    await expect(
      verifyCapabilityAccess(deps(store), makeCheck()),
    ).rejects.toMatchObject({
      kind: 'policy_denied',
      reason: 'token_quarantined',
      statusCode: 403,
    });
  });
});
