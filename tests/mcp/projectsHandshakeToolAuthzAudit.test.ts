/**
 * tests/mcp/projectsHandshakeToolAuthzAudit.test.ts — t-148 proof that
 * the MCP `projects_handshake` tool emits a single typed
 * `POLICY_HANDSHAKE` audit row per dynamic-authz outcome (allow /
 * requires_escalation / deny / adapter-error). Mirror of the HTTP
 * proof; both surfaces share the same sink + the same mapper so this
 * test checks the wiring on the MCP transport.
 */
import { describe, it, expect, beforeEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import {
  createInMemoryEngagementStore,
  __resetEngagementStoresForTests,
} from '../../src/hoplon/launcher/handshake.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { buildHandshakeMcpTool } from '../../src/hoplon/mcp/projectsHandshakeMcpTool.js';
import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../../src/hoplon/authorization/authorizationAdapter.js';

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

class FakeAdapter implements AuthorizationAdapter {
  constructor(
    private readonly buildDecision: (
      req: HoplonAuthorizationRequest,
    ) => HoplonAuthorizationDecision | Promise<HoplonAuthorizationDecision>,
  ) {}
  async evaluateAccess(req: HoplonAuthorizationRequest) {
    return this.buildDecision(req);
  }
}

const PROJECT_ID = 'p1';
const RUN_ID = 'run-t148-mcp';
const CORR_ID = 'corr-t148-mcp';

const policy: FolderPolicy = {
  defaultAccess: 'read_only',
  engagementTokenTtlMs: 60_000,
  folderRules: [
    { folder: 'src', access: 'read_write' },
    { folder: 'secrets', access: 'none' },
  ],
};

function buildTool(opts: {
  store: SnapshotStore;
  adapter?: AuthorizationAdapter;
}) {
  const launcherRoot = tmpDir('hoplon-t148-mcp-');
  fs.mkdirSync(launcherRoot, { recursive: true });
  const projectFsRoot = tmpDir('hoplon-t148-mcp-fsroot-');
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: PROJECT_ID,
    fsRoot: projectFsRoot,
    policy: { folderPolicy: policy },
  });
  const policyAuditSink = createPolicyAuditSink({
    store: opts.store,
    engineId: 'mcp-test',
  });
  const engagementStore = createInMemoryEngagementStore();
  return buildHandshakeMcpTool({
    launcherRoot,
    engagementStore,
    policyAuditSink,
    resolveAuditContext: () => ({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      correlationId: CORR_ID,
    }),
    ...(opts.adapter !== undefined ? { authorizationAdapter: opts.adapter } : {}),
  });
}

function rowsFor(store: SnapshotStore): Promise<AuditLogRecord[]> {
  return store.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
}

describe('t-148 MCP handshake authz audit (live tool proof)', () => {
  beforeEach(() => {
    __resetEngagementStoresForTests();
  });

  it('writes POLICY_HANDSHAKE GRANTED with t-148 fields on allow', async () => {
    const store = await createIsolatedTestStore();
    const tool = buildTool({ store });
    const result = await tool.handler({ projectId: PROJECT_ID, folder: 'src' });
    expect(result.isError).not.toBe(true);
    const text = (result.content[0] as { text: string }).text;
    const body = JSON.parse(text) as {
      capabilityToken: { tokenId: string; token: string };
    };
    const tokenId = body.capabilityToken.tokenId;
    const rawBearer = body.capabilityToken.token;

    const rows = await rowsFor(store);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.operation).toBe('POLICY_HANDSHAKE');
    expect(r.result).toBe('GRANTED');
    expect(r.policyEvent?.reasonCode).toBe('handshake_granted');
    expect(r.policyEvent?.policyEngine).toBe('static');
    expect(r.policyEvent?.tokenId).toBe(tokenId);
    expect(r.policyEvent?.issuedTokenId).toBe(tokenId);
    // CRITICAL H13: raw bearer must NOT appear on the persisted row.
    expect(JSON.stringify(r)).not.toContain(rawBearer);
  });

  it('writes POLICY_HANDSHAKE REAUTH_REQUIRED with handshake_requires_escalation', async () => {
    const store = await createIsolatedTestStore();
    const adapter = new FakeAdapter(() => ({
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
      reason: 'cto approval required',
      decisionId: 'opa-d-1',
      policyVersion: 'opa-v-1',
    }));
    const tool = buildTool({ store, adapter });
    const result = await tool.handler({ projectId: PROJECT_ID, folder: 'src' });
    expect(result.isError).not.toBe(true);
    const rows = await rowsFor(store);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.result).toBe('REAUTH_REQUIRED');
    expect(r.policyEvent?.reasonCode).toBe('handshake_requires_escalation');
    expect(r.policyEvent?.decisionId).toBe('opa-d-1');
  });

  it('writes POLICY_HANDSHAKE DENIED with handshake_adapter_error on adapter throw', async () => {
    const store = await createIsolatedTestStore();
    const adapter = new FakeAdapter(() => {
      throw new Error('opa unreachable');
    });
    const tool = buildTool({ store, adapter });
    const result = await tool.handler({ projectId: PROJECT_ID, folder: 'src' });
    // Deny path returns isError=true on MCP.
    expect(result.isError).toBe(true);
    const rows = await rowsFor(store);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.result).toBe('DENIED');
    expect(r.policyEvent?.reasonCode).toBe('handshake_adapter_error');
  });

  it('writes POLICY_HANDSHAKE DENIED with handshake_policy_denied on static deny', async () => {
    const store = await createIsolatedTestStore();
    const tool = buildTool({ store });
    const result = await tool.handler({
      projectId: PROJECT_ID,
      folder: 'secrets',
    });
    expect(result.isError).toBe(true);
    const rows = await rowsFor(store);
    expect(rows.length).toBe(1);
    const r = rows[0]!;
    expect(r.result).toBe('DENIED');
    expect(r.policyEvent?.reasonCode).toBe('handshake_policy_denied');
  });
});
