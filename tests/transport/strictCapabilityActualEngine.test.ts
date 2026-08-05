import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createNoopEmitter } from '../../src/hoplon/adapters/emitter/noop.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createInMemoryCapabilityClaimsStore } from '../../src/hoplon/authorization/capabilityClaimsStore.js';
import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createInMemoryEngagementStore } from '../../src/hoplon/launcher/engagementStore.js';
import { createNoopPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');
const TOKEN = 'strict-actual-engine-token';
const PROJECT_ID = 'strict-actual-engine-project';
const RUN_ID = 'strict-actual-engine-run';
const CORRELATION_ID = 'strict-actual-engine-correlation';

let codeIntelligence: Awaited<ReturnType<typeof createTreeSitterIntelligence>>;
beforeAll(async () => {
  codeIntelligence = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

describe('strict capability target identity with actual engine adapters', () => {
  it('lets the gate check the allowed stableId, then rejects a mismatched selector as STALE_TARGET', async () => {
    const fs = createMemFsAdapter({ root: '/' });
    await fs.write(
      'src/service.ts',
      new TextEncoder().encode(
        'export function allowed() { return 1; }\n' +
          'export function different() { return 2; }\n',
      ),
    );
    const snapshotStore = await createIsolatedTestStore();
    const engine = await createHoplonEngine(
      {
        fs,
        versioning: createIsomorphicGitVersioning({ fs }),
        snapshotStore,
        lockProvider: createAsyncMutexLockProvider(),
        emitter: createNoopEmitter(),
        codeIntelligence,
        secretScanner: createBuiltinRegexScanner(),
      },
      { fsRoot: '/', engineId: 'strict-actual-engine' },
    );
    const identityRead = await engine.seeCodebase({
      projectId: PROJECT_ID,
      runId: RUN_ID,
      correlationId: 'identity-read-correlation',
      intent: 'understand_code_shape',
      targets: [
        {
          kind: 'ast_node',
          file: 'src/service.ts',
          selector: { kind: 'symbol', name: 'allowed' },
        },
      ],
    });
    if (!identityRead.ok || identityRead.data.results[0]?.kind !== 'ast_node') {
      throw new Error('expected actual engine AST identity');
    }
    const allowedStableId = identityRead.data.results[0].identity.stableId;
    const claimsStore = createInMemoryCapabilityClaimsStore();
    const engagementStore = createInMemoryEngagementStore();
    const expiresAtIso = '2099-01-01T00:00:00.000Z';
    engagementStore.put(TOKEN, {
      projectId: PROJECT_ID,
      folder: 'src',
      access: 'read_only',
      principalId: 'agent-a',
      issuedAtIso: '2026-01-01T00:00:00.000Z',
      expiresAtIso,
      nonce: 'strict-actual-engine-nonce',
    });
    const capabilityToken: CapabilityEngagementToken = Object.freeze({
      token: TOKEN,
      projectId: PROJECT_ID,
      folder: 'src',
      access: 'read_only',
      principalId: 'agent-a',
      issuedAtIso: '2026-01-01T00:00:00.000Z',
      expiresAtIso,
      tokenId: 'strict-actual-engine-token-id',
      subject: 'agent-a',
      capabilities: {
        read: {
          paths: ['src/**'],
          branches: ['main'],
          astNodeIds: [allowedStableId],
        },
      },
      policy: {
        engine: 'static',
        source: 'standing_policy',
        decisionId: 'strict-actual-engine-decision',
        policyVersion: 'v1',
      },
    });
    claimsStore.put(TOKEN, capabilityToken);
    const seeCodebase = vi.spyOn(engine, 'seeCodebase');
    const server = await createHoplonHttpServer({
      engine,
      agentToolProfile: 'strict_agent',
      engagementStore,
      policyAuditSink: createNoopPolicyAuditSink(),
      capabilityGate: {
        mode: 'enforce',
        claimsStore,
        resolveBranch: () => 'main',
      },
    });

    try {
      const response = await server.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: {
          projectId: PROJECT_ID,
          runId: RUN_ID,
          correlationId: CORRELATION_ID,
          intent: 'understand_code_shape',
          targets: [
            {
              kind: 'ast_node',
              file: 'src/service.ts',
              selector: { kind: 'symbol', name: 'different' },
              expectedIdentity: { stableId: allowedStableId },
            },
          ],
          engagement: { token: TOKEN, folder: 'src', principalId: 'agent-a' },
        },
      });

      expect(response.statusCode).toBe(200);
      expect(JSON.parse(response.body)).toMatchObject({
        ok: false,
        error: { kind: 'STALE_TARGET' },
      });
      expect(JSON.parse(response.body)).not.toHaveProperty('data');
      expect(seeCodebase).toHaveBeenCalledOnce();
    } finally {
      await server.close();
    }
  });
});
