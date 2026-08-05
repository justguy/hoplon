import { describe, expect, it } from 'vitest';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { composeParallelBatchBehaviorVerification } from '../../src/hoplon/session/parallelBatchBehaviorVerification.js';
import type {
  BehaviorTestRunOutcome,
  BehaviorTestRunRequest,
  BehaviorTestRunnerAdapter,
} from '../../src/hoplon/adapters/behaviorTestRunner.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolveGrammarsDir();
const TEST_FILE = 'tests/integration.test.ts';

function resolveGrammarsDir(): string {
  const candidates = [
    process.env['HOPLON_GRAMMARS_DIR'],
    join(REPO_ROOT, 'vendor/grammars'),
    primaryCheckoutGrammarsDir(),
    ...ancestorGrammarDirs(REPO_ROOT),
  ];

  for (const candidate of candidates) {
    if (
      candidate !== undefined &&
      existsSync(join(candidate, 'tree-sitter.wasm'))
    ) {
      return candidate;
    }
  }

  return join(REPO_ROOT, 'vendor/grammars');
}

function primaryCheckoutGrammarsDir(): string | undefined {
  const marker = `${sep}.claude${sep}worktrees${sep}`;
  const markerIndex = REPO_ROOT.indexOf(marker);
  if (markerIndex === -1) return undefined;
  return join(REPO_ROOT.slice(0, markerIndex), 'vendor/grammars');
}

function ancestorGrammarDirs(start: string): string[] {
  const candidates: string[] = [];
  let current = start;
  while (true) {
    candidates.push(join(current, 'vendor/grammars'));
    const parent = dirname(current);
    if (parent === current) return candidates;
    current = parent;
  }
}

function makeWorkspace(): string {
  const root = mkdtempSync(join(tmpdir(), 'hoplon-t091-int-'));
  mkdirSync(join(root, 'src'), { recursive: true });
  mkdirSync(join(root, 'tests'), { recursive: true });
  mkdirSync(join(root, '.hoplon'), { recursive: true });
  writeFileSync(
    join(root, 'src/producer.ts'),
    "export const payload = 'v1';\n",
  );
  writeFileSync(
    join(root, 'src/consumer.ts'),
    "import { payload } from './producer.js';\n" +
      'export const consumed = payload;\n',
  );
  writeFileSync(
    join(root, TEST_FILE),
    "import { consumed } from '../src/consumer.js';\n" +
      "export const observed = consumed;\n",
  );
  return root;
}

async function createEngine(root: string) {
  return createDefaultHoplonEngine({
    root,
    dbPath: join(root, '.hoplon/hoplon.db'),
    gitRepoDir: join(root, '.hoplon/repo'),
    grammarsDir: GRAMMARS_DIR,
    engineId: 't091-integration',
  });
}

function passOutcome(req: BehaviorTestRunRequest): BehaviorTestRunOutcome {
  return {
    runnerId: 'integration-stub-runner',
    startedAt: '2026-04-26T00:00:00Z',
    completedAt: '2026-04-26T00:00:01Z',
    durationMs: 1_000,
    workingDirectory: req.projectRoot,
    exitStatus: { kind: 'exit_code', code: 0, signal: null, reason: null },
    failingTests: [],
    passingTestCount: req.testFiles.length,
    skippedTestCount: 0,
    stdout: 'integration pass',
    stderr: null,
    structured: { selected: req.testFiles },
    truncated: false,
  };
}

function failOutcome(req: BehaviorTestRunRequest): BehaviorTestRunOutcome {
  return {
    runnerId: 'integration-stub-runner',
    startedAt: '2026-04-26T00:00:00Z',
    completedAt: '2026-04-26T00:00:01Z',
    durationMs: 1_000,
    workingDirectory: req.projectRoot,
    exitStatus: { kind: 'exit_code', code: 1, signal: null, reason: null },
    failingTests: [
      {
        testId: `${TEST_FILE} > observes producer/consumer contract`,
        name: 'observes producer/consumer contract',
        file: TEST_FILE,
        failureMessage: 'producer/consumer semantic drift',
        stack: null,
        durationMs: 12,
        assertions: [{ expected: 'v1', actual: 'v2' }],
      },
    ],
    passingTestCount: 0,
    skippedTestCount: 0,
    stdout: 'integration fail',
    stderr: null,
    structured: { selected: req.testFiles },
    truncated: false,
  };
}

function recordingRunner(
  buildOutcome: (req: BehaviorTestRunRequest) => BehaviorTestRunOutcome,
): BehaviorTestRunnerAdapter & { readonly requests: BehaviorTestRunRequest[] } {
  const requests: BehaviorTestRunRequest[] = [];
  return {
    id: 'integration-stub-runner',
    requests,
    async describeAvailability() {
      return { available: true };
    },
    async run(req) {
      requests.push(req);
      return buildOutcome(req);
    },
  };
}

const sessions = [
  {
    sessionId: 'sess-producer',
    changedFiles: ['src/producer.ts'],
    snapshotRefId: 'sha256:producer',
    attemptNumber: 1,
  },
  {
    sessionId: 'sess-consumer',
    changedFiles: ['src/consumer.ts'],
    snapshotRefId: 'sha256:consumer',
    attemptNumber: 1,
  },
];

describe('parallel batch behavior verification integration', () => {
  it('uses the real test oracle and mirrors PASS for compatible batch edits', async () => {
    const root = makeWorkspace();
    try {
      const engine = await createEngine(root);
      const runner = recordingRunner(passOutcome);

      const result = await composeParallelBatchBehaviorVerification({
        engine,
        runner,
        sessions,
        options: {},
        projectId: 'proj-t091-integration',
        runId: 'run-t091-integration-pass',
        correlationId: 'corr-t091-integration-pass',
        projectRoot: root,
        now: () => 1_776_000_000_000,
      });

      expect(result.outcome).toBe('PASS');
      expect(result.verifyBehavior.selection.strategy).toBe('oracle');
      expect(result.verifyBehavior.selection.testsExecuted).toEqual([TEST_FILE]);
      expect(result.verifyBehavior.selection.oracleResult).toEqual({
        relevantTests: [TEST_FILE],
        coverageConfidence: 'exact',
        unusedModifiedFiles: [],
      });
      expect(runner.requests).toHaveLength(1);
      expect(runner.requests[0]?.testFiles).toEqual([TEST_FILE]);
      expect(result.selection.unionedChangedFiles).toEqual([
        'src/consumer.ts',
        'src/producer.ts',
      ]);
      expect(result.failureLinkage.entries).toEqual([]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);

  it('uses the real test oracle and links FAIL evidence to candidate sessions', async () => {
    const root = makeWorkspace();
    try {
      const engine = await createEngine(root);
      const runner = recordingRunner(failOutcome);

      const result = await composeParallelBatchBehaviorVerification({
        engine,
        runner,
        sessions,
        options: {},
        projectId: 'proj-t091-integration',
        runId: 'run-t091-integration-fail',
        correlationId: 'corr-t091-integration-fail',
        projectRoot: root,
        now: () => 1_776_000_000_000,
      });

      expect(result.outcome).toBe('FAIL');
      expect(result.verifyBehavior.selection.testsExecuted).toEqual([TEST_FILE]);
      expect(result.verifyBehavior.evidence.failingTests[0]?.failureMessage).toBe(
        'producer/consumer semantic drift',
      );
      expect(result.failureLinkage.entries).toEqual([
        {
          testFile: TEST_FILE,
          candidateSessionIds: ['sess-consumer', 'sess-producer'],
        },
      ]);
      expect(result.failureLinkage.unattributedFailureIds).toEqual([]);
      expect(runner.requests[0]?.testFiles).toEqual([TEST_FILE]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }, 60_000);
});
