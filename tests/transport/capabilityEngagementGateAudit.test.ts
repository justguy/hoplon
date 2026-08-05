/**
 * tests/transport/capabilityEngagementGateAudit.test.ts — t-148 proof
 * that `verifyCapabilityAccess` emits a `POLICY_CAPABILITY_CHECK` audit
 * row for every ok / denied / reauth_required outcome when the
 * `auditSink` + `auditContext` deps are wired.
 */
import { describe, it, expect } from 'vitest';

import {
  verifyCapabilityAccess,
  CapabilityDeniedError,
  type CapabilityGateDeps,
} from '../../src/hoplon/transport/capabilityEngagementGate.js';
import { createInMemoryCapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';
import type {
  PolicyAuditContext,
  PolicyAuditSink,
} from '../../src/hoplon/transport/policyAuditSink.js';
import type { CapabilityCheckOutcome } from '../../src/hoplon/transport/policyAuditSink.js';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const FUTURE = new Date('2026-05-04T12:00:00.000Z');
const PAST = new Date('2026-05-01T12:00:00.000Z');
const TOKEN = 'opaque-token-bytes-1';
const TOKEN_ID = 'tk_t148_cap_audit';
const RAW_BEARER = 'super-secret-do-not-leak';

interface RecordedRow {
  context: PolicyAuditContext;
  outcome: CapabilityCheckOutcome;
  durationMs: number;
}

function makeRecordingSink(): PolicyAuditSink & { rows: RecordedRow[] } {
  const rows: RecordedRow[] = [];
  return {
    rows,
    recordHandshakeGrant: async () => {},
    recordHandshakeDeny: async () => {},
    recordAccessCheck: async () => {},
    recordRenew: async () => {},
    recordRevoke: async () => {},
    recordHandshakeAuthzOutcome: async () => {},
    async recordCapabilityCheck(context, outcome, durationMs) {
      rows.push({ context, outcome, durationMs });
    },
  };
}

function makeToken(
  expiresAt: string = FUTURE.toISOString(),
): CapabilityEngagementToken {
  return Object.freeze({
    token: RAW_BEARER,
    projectId: 'p1',
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: '2026-05-02T00:00:00.000Z',
    expiresAtIso: expiresAt,
    tokenId: TOKEN_ID,
    subject: 'agent-a',
    sessionId: 'sess-1',
    capabilities: {
      read: { paths: ['src/**'], branches: ['main'] },
      write: { paths: ['src/**'], branches: ['main'] },
    },
    policy: {
      engine: 'static',
      source: 'standing_policy',
      decisionId: 'd-1',
      policyVersion: 'v1',
    },
  });
}

const CTX: PolicyAuditContext = {
  projectId: 'p1',
  runId: 'run-x',
  correlationId: 'corr-x',
};

function buildDeps(opts: {
  sink: PolicyAuditSink;
  token?: CapabilityEngagementToken | null;
}): CapabilityGateDeps {
  const claimsStore = createInMemoryCapabilityClaimsStore();
  if (opts.token !== null && opts.token !== undefined) {
    claimsStore.put(TOKEN, opts.token);
  }
  return {
    claimsStore,
    mode: 'enforce',
    clock: () => NOW,
    auditSink: opts.sink,
    auditContext: CTX,
  };
}

describe('t-148 verifyCapabilityAccess audit emission', () => {
  it('emits one capability_granted row on ok', async () => {
    const sink = makeRecordingSink();
    const deps = buildDeps({ sink, token: makeToken() });
    await verifyCapabilityAccess(deps, {
      engagement: {
        token: TOKEN,
        projectId: 'p1',
        folder: 'src',
        access: 'read_write',
        principalId: 'agent-a',
      },
      correlationId: 'corr-x',
      capability: 'read',
      projectId: 'p1',
      branch: 'main',
      path: 'src/foo.ts',
    });
    expect(sink.rows).toHaveLength(1);
    const r = sink.rows[0]!;
    expect(r.outcome.assertion.kind).toBe('ok');
    expect(r.outcome.token?.tokenId).toBe(TOKEN_ID);
  });

  it('emits one capability_denied_path_mismatch row on path mismatch', async () => {
    const sink = makeRecordingSink();
    const deps = buildDeps({ sink, token: makeToken() });
    await expect(
      verifyCapabilityAccess(deps, {
        engagement: {
          token: TOKEN,
          projectId: 'p1',
          folder: 'src',
          access: 'read_write',
          principalId: 'agent-a',
        },
        correlationId: 'corr-x',
        capability: 'read',
        projectId: 'p1',
        branch: 'main',
        path: 'docs/foo.md',
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(sink.rows).toHaveLength(1);
    const r = sink.rows[0]!;
    expect(r.outcome.assertion.kind).toBe('denied');
  });

  it('emits one reauth row when the token is expired', async () => {
    const sink = makeRecordingSink();
    const deps = buildDeps({ sink, token: makeToken(PAST.toISOString()) });
    await expect(
      verifyCapabilityAccess(deps, {
        engagement: {
          token: TOKEN,
          projectId: 'p1',
          folder: 'src',
          access: 'read_write',
          principalId: 'agent-a',
        },
        correlationId: 'corr-x',
        capability: 'read',
        projectId: 'p1',
        branch: 'main',
        path: 'src/foo.ts',
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]!.outcome.assertion.kind).toBe('reauth_required');
  });

  it('emits a reauth row when the token is not found in the claims store', async () => {
    const sink = makeRecordingSink();
    const deps = buildDeps({ sink, token: null });
    await expect(
      verifyCapabilityAccess(deps, {
        engagement: {
          token: TOKEN,
          projectId: 'p1',
          folder: 'src',
          access: 'read_write',
          principalId: 'agent-a',
        },
        correlationId: 'corr-x',
        capability: 'read',
        projectId: 'p1',
        branch: 'main',
        path: 'src/foo.ts',
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]!.outcome.token).toBeNull();
  });

  it('emits a denied row with policy_denied (503) when no claims store wired', async () => {
    const sink = makeRecordingSink();
    const deps: CapabilityGateDeps = {
      mode: 'enforce',
      clock: () => NOW,
      auditSink: sink,
      auditContext: CTX,
    };
    await expect(
      verifyCapabilityAccess(deps, {
        engagement: {
          token: TOKEN,
          projectId: 'p1',
          folder: 'src',
          access: 'read_write',
          principalId: 'agent-a',
        },
        correlationId: 'corr-x',
        capability: 'read',
        projectId: 'p1',
        branch: 'main',
        path: 'src/foo.ts',
      }),
    ).rejects.toBeInstanceOf(CapabilityDeniedError);
    expect(sink.rows).toHaveLength(1);
    expect(sink.rows[0]!.outcome.assertion.kind).toBe('denied');
  });

  it('emits NO row when the gate is in mode "off"', async () => {
    const sink = makeRecordingSink();
    const claimsStore = createInMemoryCapabilityClaimsStore();
    claimsStore.put(TOKEN, makeToken());
    const deps: CapabilityGateDeps = {
      claimsStore,
      mode: 'off',
      clock: () => NOW,
      auditSink: sink,
      auditContext: CTX,
    };
    await verifyCapabilityAccess(deps, {
      engagement: {
        token: TOKEN,
        projectId: 'p1',
        folder: 'src',
        access: 'read_write',
        principalId: 'agent-a',
      },
      correlationId: 'corr-x',
      capability: 'read',
      projectId: 'p1',
      branch: 'main',
      path: 'src/foo.ts',
    });
    expect(sink.rows).toHaveLength(0);
  });

  it('audit-sink throw does NOT change the gate decision', async () => {
    const throwingSink: PolicyAuditSink = {
      recordHandshakeGrant: async () => {},
      recordHandshakeDeny: async () => {},
      recordAccessCheck: async () => {},
      recordRenew: async () => {},
      recordRevoke: async () => {},
      recordHandshakeAuthzOutcome: async () => {},
      recordCapabilityCheck: async () => {
        throw new Error('audit sink down');
      },
    };
    const deps = buildDeps({ sink: throwingSink, token: makeToken() });
    // Should not throw — the gate decision is `ok` regardless of the
    // audit-sink throw.
    await verifyCapabilityAccess(deps, {
      engagement: {
        token: TOKEN,
        projectId: 'p1',
        folder: 'src',
        access: 'read_write',
        principalId: 'agent-a',
      },
      correlationId: 'corr-x',
      capability: 'read',
      projectId: 'p1',
      branch: 'main',
      path: 'src/foo.ts',
    });
  });
});
