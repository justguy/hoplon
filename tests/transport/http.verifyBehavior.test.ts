/**
 * tests/transport/http.verifyBehavior.test.ts — packaged HTTP route proof (t-067).
 *
 * Exercises `POST /session/verifyBehavior` on the shipped Fastify server via
 * `fastify.inject()`. The test uses a mock engine and stub runner so it stays
 * hermetic and focused on transport / contract wiring; real tree-sitter +
 * real session coverage lives in the selfhost proof.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createStubBehaviorTestRunner } from '../../src/hoplon/adapters/behaviorTestRunner.js';
import type { BehaviorTestRunOutcome } from '../../src/hoplon/adapters/behaviorTestRunner.js';
import { VerifyBehaviorResultSchema } from '../../src/hoplon/contracts/verifyBehavior.js';
import type { VerifyBehaviorResult } from '../../src/hoplon/contracts/verifyBehavior.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { TestOracleResult } from '../../src/hoplon/contracts/getRelevantTests.js';
import { makeMockEngine, MANIFEST } from '../session/helpers.js';

function failEnvelope(): BehaviorTestRunOutcome {
  return {
    runnerId: 'stub-http',
    startedAt: '2026-04-21T00:00:00Z',
    completedAt: '2026-04-21T00:00:02Z',
    durationMs: 2_000,
    workingDirectory: '/ws',
    exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
    failingTests: [
      {
        testId: 'tests/alpha.test.ts > returns seven',
        name: 'returns seven',
        file: 'tests/alpha.test.ts',
        failureMessage: 'expected 1 to equal 7',
        stack: 'Error: assertion failed\n    at tests/alpha.test.ts:10:5',
        durationMs: 5,
        assertions: [{ expected: 7, actual: 1 }],
      },
    ],
    passingTestCount: 2,
    skippedTestCount: 0,
    stdout: 'FAIL tests/alpha.test.ts > returns seven',
    stderr: null,
    structured: { total: 3, failed: 1 },
    truncated: false,
  };
}

function engineWithOracle(result: TestOracleResult): HoplonEngine {
  return makeMockEngine({
    getRelevantTests: async () => result,
  } as Partial<HoplonEngine>);
}

describe('HTTP /session/verifyBehavior (t-067)', () => {
  it('surfaces FAIL evidence over the packaged route without truncation', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const a = 1;\n'));

    const engine = engineWithOracle({
      relevantTests: ['tests/alpha.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const runner = createStubBehaviorTestRunner({
      id: 'stub-http',
      fixtures: [
        {
          matches: { kind: 'testFiles', testFiles: ['tests/alpha.test.ts'] },
          outcome: failEnvelope(),
        },
      ],
    });
    const registry = createSessionRegistry({
      engine,
      fs,
      behaviorTestRunner: runner,
      projectRoot: '/ws',
    });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });

    try {
      const startRes = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: { manifest: MANIFEST },
      });
      expect(startRes.statusCode).toBe(200);
      const sessionId = JSON.parse(startRes.body).session.sessionId as string;

      await server.inject({ method: 'POST', url: '/session/preflight', payload: { sessionId } });
      await server.inject({ method: 'POST', url: '/session/createSnapshot', payload: { sessionId } });
      await server.inject({
        method: 'POST',
        url: '/session/markEdited',
        payload: { sessionId, files: ['src/foo.ts'] },
      });

      const verifyRes = await server.inject({
        method: 'POST',
        url: '/session/verifyBehavior',
        payload: { sessionId },
      });
      expect(verifyRes.statusCode).toBe(200);
      const body = JSON.parse(verifyRes.body) as {
        data: { verification: VerifyBehaviorResult };
      };
      const verification = body.data.verification;
      const validated = VerifyBehaviorResultSchema.safeParse(verification);
      expect(validated.success).toBe(true);
      expect(verification.status).toBe('AVAILABLE');
      expect(verification.outcome).toBe('FAIL');
      expect(verification.selection.strategy).toBe('oracle');
      expect(verification.selection.testsExecuted).toEqual([
        'tests/alpha.test.ts',
      ]);
      expect(verification.evidence.failingTests).toHaveLength(1);
      expect(verification.evidence.failingTests[0]?.failureMessage).toBe(
        'expected 1 to equal 7',
      );
      expect(verification.evidence.stdout).toContain(
        'FAIL tests/alpha.test.ts > returns seven',
      );
      expect(verification.evidence.structured).toEqual({ total: 3, failed: 1 });
      expect(verification.execution.runnerId).toBe('stub-http');
      expect(verification.linkage.sessionId).toBe(sessionId);
      expect(verification.linkage.changedFiles).toEqual(['src/foo.ts']);
    } finally {
      await server.close();
      registry.dispose();
    }
  });

  it('returns UNAVAILABLE/no_runner when the launcher did not wire a runner', async () => {
    const fs = createMemFsAdapter();
    const engine = engineWithOracle({
      relevantTests: ['tests/alpha.test.ts'],
      coverageConfidence: 'exact',
      unusedModifiedFiles: [],
    });
    const registry = createSessionRegistry({
      engine,
      fs,
      projectRoot: '/ws',
    });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    try {
      const startRes = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: { manifest: MANIFEST },
      });
      const sessionId = JSON.parse(startRes.body).session.sessionId as string;

      const verifyRes = await server.inject({
        method: 'POST',
        url: '/session/verifyBehavior',
        payload: { sessionId },
      });
      expect(verifyRes.statusCode).toBe(200);
      const body = JSON.parse(verifyRes.body) as {
        data: { verification: VerifyBehaviorResult };
      };
      expect(body.data.verification.status).toBe('UNAVAILABLE');
      expect(body.data.verification.outcome).toBe('NOT_RUN');
      expect(body.data.verification.unavailabilityReason).toBe('no_runner');
      expect(body.data.verification.notes).toContain('runner_not_injected');
    } finally {
      await server.close();
      registry.dispose();
    }
  });
});
