/**
 * tests/transport/strictEngagementGate.parallelCapability.test.ts —
 * T-147 proof that the legacy strict engagement gate and the new
 * capability gate run in PARALLEL when both are configured.
 *
 * Invariants under test:
 *   1. Default (no capability deps): only the legacy gate runs.
 *      Existing behavior is unchanged.
 *   2. Both gates configured + capability mode `off`: only the legacy
 *      gate runs (existing behavior is preserved when an operator
 *      adds the wiring but has not yet flipped the flag).
 *   3. Both gates configured + capability mode `enforce`:
 *      a. Legacy fails  → legacy error (capability gate not consulted).
 *      b. Legacy passes + capability fails → capability error.
 *      c. Legacy passes + capability passes → ok.
 *
 * The legacy gate is exercised through its real `verifyStrictEngagementAccess`
 * helper with an in-memory `EngagementStore`, no-op `PolicyAuditSink`,
 * and the existing typed errors.
 */

import { describe, expect, it } from 'vitest';

import {
  verifyStrictEngagementAccess,
  type StrictEngagementCheck,
  type StrictEngagementGateDeps,
} from '../../src/hoplon/transport/strictEngagementGate.js';
import { StrictEngagementError } from '../../src/hoplon/transport/strictEngagementGate.js';
import { CapabilityDeniedError } from '../../src/hoplon/transport/capabilityEngagementGate.js';
import {
  createInMemoryEngagementStore,
  type EngagementStore,
} from '../../src/hoplon/launcher/engagementStore.js';
import {
  createInMemoryCapabilityClaimsStore,
  type CapabilityClaimsStore,
} from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import { createNoopPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const FUTURE = new Date('2026-05-04T12:00:00.000Z');
const PROJECT_ID = 'proj-x';
const FOLDER = 'src';
const PRINCIPAL = 'agent-a';
const TOKEN = 'opaque-token-bytes';

function seedEngagement(store: EngagementStore): void {
  store.put(TOKEN, {
    projectId: PROJECT_ID,
    folder: FOLDER,
    access: 'read_write',
    principalId: PRINCIPAL,
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: FUTURE.toISOString(),
    nonce: 'nonce-1',
  });
}

function seedClaim(store: CapabilityClaimsStore): void {
  const token: CapabilityEngagementToken = Object.freeze({
    token: TOKEN,
    projectId: PROJECT_ID,
    folder: FOLDER,
    access: 'read_write',
    principalId: PRINCIPAL,
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: FUTURE.toISOString(),
    tokenId: 'token-id-1',
    subject: PRINCIPAL,
    sessionId: 'session-1',
    capabilities: {
      read: { paths: ['src/**'], branches: ['main'] },
    },
    policy: {
      engine: 'static',
      source: 'standing_policy',
      decisionId: 'decision-1',
      policyVersion: 'v1',
    },
  }) as CapabilityEngagementToken;
  store.put(TOKEN, token);
}

function baseDeps(store: EngagementStore): StrictEngagementGateDeps {
  return {
    store,
    sink: createNoopPolicyAuditSink(),
    engineId: 'test',
    clock: () => NOW,
  };
}

function makeCheck(
  overrides: Partial<StrictEngagementCheck> = {},
): StrictEngagementCheck {
  return {
    engagement: { token: TOKEN, folder: FOLDER, principalId: PRINCIPAL },
    projectId: PROJECT_ID,
    runId: 'run-1',
    correlationId: 'corr-1',
    action: 'read',
    requiredAccess: 'read_only',
    capability: {
      key: 'read',
      branch: 'main',
      path: 'src/foo.ts',
      sessionId: 'session-1',
    },
    ...overrides,
  };
}

describe('parallel gate composition (T-147)', () => {
  it('runs only the legacy gate when no capability deps are supplied', async () => {
    const store = createInMemoryEngagementStore();
    seedEngagement(store);
    await expect(
      verifyStrictEngagementAccess(baseDeps(store), makeCheck()),
    ).resolves.toBeUndefined();
  });

  it('preserves legacy behavior when capability mode is `off`', async () => {
    const store = createInMemoryEngagementStore();
    seedEngagement(store);
    const claims = createInMemoryCapabilityClaimsStore();
    // No claim seeded — but mode is `off` so the gate must not fire.
    await expect(
      verifyStrictEngagementAccess(
        {
          ...baseDeps(store),
          capability: {
            claimsStore: claims,
            mode: 'off',
            clock: () => NOW,
          },
        },
        makeCheck(),
      ),
    ).resolves.toBeUndefined();
  });

  it('legacy failure short-circuits the capability gate', async () => {
    // No engagement seeded → legacy gate fails. Even with claims wired
    // in `enforce`, the capability gate must not be consulted.
    const store = createInMemoryEngagementStore();
    const claims = createInMemoryCapabilityClaimsStore();
    seedClaim(claims);
    let caught: unknown;
    try {
      await verifyStrictEngagementAccess(
        {
          ...baseDeps(store),
          capability: { claimsStore: claims, mode: 'enforce', clock: () => NOW },
        },
        makeCheck(),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(StrictEngagementError);
    expect(caught).not.toBeInstanceOf(CapabilityDeniedError);
  });

  it('legacy passes + capability fails → capability error', async () => {
    const store = createInMemoryEngagementStore();
    seedEngagement(store);
    const claims = createInMemoryCapabilityClaimsStore();
    seedClaim(claims);
    let caught: unknown;
    try {
      await verifyStrictEngagementAccess(
        {
          ...baseDeps(store),
          capability: { claimsStore: claims, mode: 'enforce', clock: () => NOW },
        },
        // request branch is `feature/x`, capability is bound to `main`.
        makeCheck({
          capability: {
            key: 'read',
            branch: 'feature/x',
            path: 'src/foo.ts',
            sessionId: 'session-1',
          },
        }),
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapabilityDeniedError);
    if (caught instanceof CapabilityDeniedError) {
      expect(caught.reason).toBe('branch_mismatch');
    }
  });

  it('both gates pass → ok', async () => {
    const store = createInMemoryEngagementStore();
    seedEngagement(store);
    const claims = createInMemoryCapabilityClaimsStore();
    seedClaim(claims);
    await expect(
      verifyStrictEngagementAccess(
        {
          ...baseDeps(store),
          capability: { claimsStore: claims, mode: 'enforce', clock: () => NOW },
        },
        makeCheck(),
      ),
    ).resolves.toBeUndefined();
  });

  it('fails closed under enforce when no capability facts are supplied', async () => {
    const store = createInMemoryEngagementStore();
    seedEngagement(store);
    const claims = createInMemoryCapabilityClaimsStore();
    seedClaim(claims);
    const check: StrictEngagementCheck = {
      engagement: { token: TOKEN, folder: FOLDER, principalId: PRINCIPAL },
      projectId: PROJECT_ID,
      runId: 'run-1',
      correlationId: 'corr-1',
      action: 'read',
      requiredAccess: 'read_only',
    };
    // hcr-004 finding 5: enforce mode must not be bypassable by omitting the
    // capability facts. A call site that supplies neither a capability spec
    // nor derived facts is checked against minimal derived facts (no branch,
    // no path), which a constrained token fails closed with a typed reason.
    let caught: unknown;
    try {
      await verifyStrictEngagementAccess(
        {
          ...baseDeps(store),
          capability: { claimsStore: claims, mode: 'enforce', clock: () => NOW },
        },
        check,
      );
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(CapabilityDeniedError);
    if (caught instanceof CapabilityDeniedError) {
      expect(caught.kind).toBe('reauth_required');
      expect(caught.reason).toBe('missing_branch');
    }
  });
});
