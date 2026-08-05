import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { RbaaAuthorizationAdapter } from '../../src/hoplon/authorization/rbaaAuthorizationAdapter.js';
import type { RbaaAuthorizationClient } from '../../src/hoplon/authorization/rbaaAuthorizationClient.js';
import type {
  RbaaAuthorizationDecision,
  RbaaAuthorizationRequest,
  RbaaRiskFacts,
} from '../../src/hoplon/contracts/rbaaAuthorization.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/handshake.js';
import { issueProjectHandshakeViaAdapter } from '../../src/hoplon/launcher/handshakeAuthz.js';
import { createInMemoryCapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import type { CapabilityDeniedError } from '../../src/hoplon/transport/capabilityEngagementGate.js';
import {
  verifyCapabilityAccess,
} from '../../src/hoplon/transport/capabilityEngagementGate.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';

const NOW_ISO = '2026-05-06T12:00:00.000Z';
const NOW = new Date(NOW_ISO);
const PROJECT_ID = 'hoplon';
const PRINCIPAL_ID = 'agent-rbaa-e2e';
const SESSION_ID = 'session-rbaa-e2e';
const TASK_ID = 'task-rbaa-e2e';
const BRANCH = 'feature/rbaa-e2e';
const TARGET_PATH = 'src/hoplon/rbaaE2E.ts';
const RUN_ID = 'run-rbaa-e2e';
const CORR_ID = 'corr-rbaa-e2e';

const policy: FolderPolicy = {
  defaultAccess: 'read_write',
  engagementTokenTtlMs: 300_000,
  folderRules: [{ folder: 'src', access: 'read_write' }],
  principals: [{ principalId: PRINCIPAL_ID, kind: 'agent' }],
};

function tmpDir(prefix: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

function riskFacts(): RbaaRiskFacts {
  return {
    projectId: PROJECT_ID,
    branch: BRANCH,
    sessionId: SESSION_ID,
    evaluatedAt: NOW_ISO,
    facts: [
      {
        id: 'risk-factor-e2e',
        source: 'control_plane',
        label: 'scoped RBAA edit',
        severity: 'medium',
      },
    ],
  };
}

function allowDecision(
  request: RbaaAuthorizationRequest,
): RbaaAuthorizationDecision {
  return {
    schemaVersion: 1,
    outcome: 'allow',
    source: 'escalation_grant',
    decisionId: 'rbaa-e2e-decision-1',
    policyVersion: 'rbaa-policy-v1-e2e',
    risk: {
      evaluationId: 'risk-eval-e2e',
      band: 'R1_GUARDED',
      scoreBucket: '20-39',
      autonomyTier: 'A2_SCOPED_EDITOR',
      controls: ['max_edit_operations', 'max_files_touched', 'enhanced_audit'],
      topFactors: request.riskFacts.facts,
    },
    capabilities: {
      write: {
        paths: [TARGET_PATH],
        branches: [BRANCH],
        maxOperations: 1,
        maxFilesTouched: 1,
      },
    },
    limits: { expiresInSeconds: 300, maxOperations: 1, maxFilesTouched: 1 },
    grantIds: ['grant-rbaa-e2e'],
  };
}

class CapturingRbaaClient implements RbaaAuthorizationClient {
  readonly requests: RbaaAuthorizationRequest[] = [];

  async evaluateAuthorization(request: RbaaAuthorizationRequest) {
    this.requests.push(request);
    return { kind: 'ok' as const, rawDecision: allowDecision(request) };
  }
}

describe('dynamic RBAA opt-in E2E', () => {
  it('runs request -> risk -> policy -> token -> protected operation -> audit', async () => {
    const launcherRoot = tmpDir('hoplon-rbaa-e2e-');
    const projectRoot = tmpDir('hoplon-rbaa-e2e-project-');
    const manager = openLauncherProjects(launcherRoot);
    manager.register({
      projectId: PROJECT_ID,
      fsRoot: projectRoot,
      policy: { folderPolicy: policy },
    });
    const client = new CapturingRbaaClient();
    const adapter = new RbaaAuthorizationAdapter({
      client,
      hostProfile: 'agentic_os_control_plane',
      riskFactsProvider: {
        async buildRiskFacts() {
          return { kind: 'ok', riskFacts: riskFacts() };
        },
      },
      activeGrantProvider: {
        async listActiveGrants() {
          return {
            kind: 'ok',
            activeGrants: [
              {
                grantId: 'grant-rbaa-e2e',
                principalId: PRINCIPAL_ID,
                projectId: PROJECT_ID,
                taskId: TASK_ID,
                capabilities: {
                  write: {
                    paths: [TARGET_PATH],
                    branches: [BRANCH],
                    maxOperations: 1,
                    maxFilesTouched: 1,
                  },
                },
                grantedBy: 'human-reviewer',
                issuedAt: '2026-05-06T11:55:00.000Z',
                expiresAt: '2026-05-06T12:05:00.000Z',
              },
            ],
          };
        },
      },
      engineName: 'rbaa',
      generateDecisionId: () => 'rbaa-e2e-error',
    });
    const engagementStore = createInMemoryEngagementStore();
    const claimsStore = createInMemoryCapabilityClaimsStore();
    const auditStore = await createIsolatedTestStore();
    const auditSink = createPolicyAuditSink({
      store: auditStore,
      engineId: 'rbaa-e2e',
    });

    const result = await issueProjectHandshakeViaAdapter(
      { projectId: PROJECT_ID, folder: 'src', principalId: PRINCIPAL_ID },
      {
        registry: manager.registry,
        store: engagementStore,
        adapter,
        capabilityClaimsStore: claimsStore,
        clock: () => NOW,
        randomToken: () => 'raw-rbaa-e2e-token',
        generateTokenId: () => 'rbaa-e2e-token-id',
        sessionId: SESSION_ID,
        taskId: TASK_ID,
        branch: BRANCH,
        requestedCapabilities: ['write'],
        paths: [TARGET_PATH],
        engineName: 'rbaa',
      },
    );

    expect(result.kind).toBe('allow');
    if (result.kind !== 'allow') return;
    expect(client.requests).toHaveLength(1);
    expect(client.requests[0]?.riskFacts.facts[0]?.id).toBe('risk-factor-e2e');
    expect(result.capabilityToken.policy.rbaa?.limits).toMatchObject({
      maxOperations: 1,
      maxFilesTouched: 1,
    });

    const gate = {
      claimsStore,
      mode: 'enforce' as const,
      clock: () => NOW,
      auditSink,
      auditContext: {
        projectId: PROJECT_ID,
        runId: RUN_ID,
        correlationId: CORR_ID,
      },
    };
    const check = {
      engagement: {
        token: result.engagement.token,
        folder: 'src',
        principalId: PRINCIPAL_ID,
      },
      correlationId: CORR_ID,
      capability: 'write' as const,
      projectId: PROJECT_ID,
      branch: BRANCH,
      path: TARGET_PATH,
      sessionId: SESSION_ID,
      taskId: TASK_ID,
    };

    await verifyCapabilityAccess(gate, check);
    expect(claimsStore.getRuntimeState(result.engagement.token)).toMatchObject({
      operationCount: 1,
      touchedFiles: [TARGET_PATH],
    });

    await expect(verifyCapabilityAccess(gate, check)).rejects.toMatchObject({
      name: 'CapabilityDeniedError',
      kind: 'reauth_required',
      reason: 'operation_limit_exceeded',
    } satisfies Partial<CapabilityDeniedError>);

    const rows = await auditStore.findAuditLogByProjectAndRun(PROJECT_ID, RUN_ID);
    expect(rows.map((row) => row.policyEvent?.reasonCode)).toEqual([
      'capability_granted',
      'capability_reauth_operation_limit_exceeded',
    ]);
    expect(rows[0]?.policyEvent?.rbaaEvidence).toMatchObject({
      tokenId: 'rbaa-e2e-token-id',
      decisionId: 'rbaa-e2e-decision-1',
      policyVersion: 'rbaa-policy-v1-e2e',
      limits: { maxOperations: 1, maxFilesTouched: 1 },
      outcome: 'allow',
    });
    expect(JSON.stringify(rows)).not.toContain(result.engagement.token);
  });
});
