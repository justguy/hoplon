/**
 * tests/operations/checkSignatures.test.ts — LC3 checkSignatures targeted test suite.
 *
 * 5 required tests (LC3-1 through LC3-5).
 *
 * Uses:
 *   - createTreeSitterIntelligence()  — real WASM grammars (D3)
 *   - createMemFsAdapter()            — in-memory fs (C2)
 *   - createIsomorphicGitVersioning() — real in-memory git (C4)
 *   - createIsolatedTestStore()       — in-memory SQLite snapshot store (C1)
 *   - createMemoryEmitter()           — in-memory event store (C5)
 *
 * Critical proofs:
 *   LC3-1: matching signature → PASS
 *   LC3-2: mismatched param count → BLOCK with SIGNATURE_MISMATCH + actual/expected
 *   LC3-3: generic function → UNCERTAIN with SIGNATURE_UNCERTAIN
 *   LC3-4: no signatureContracts on manifest → PASS (skipped)
 *   LC3-5: dryRun integration — SIGNATURE_MISMATCH surfaces in AuditResult
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { checkSignatures } from '../../src/hoplon/operations/checkSignatures.js';
import type { CheckSignaturesDeps } from '../../src/hoplon/operations/checkSignatures.js';
import { dryRun } from '../../src/hoplon/operations/dryRun.js';
import type { DryRunDeps } from '../../src/hoplon/operations/dryRun.js';
import { createSnapshot } from '../../src/hoplon/operations/createSnapshot.js';
import type { CreateSnapshotDeps } from '../../src/hoplon/operations/createSnapshot.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest, SignatureContract } from '../../src/hoplon/contracts/manifest.js';
import type { DryRunRequest } from '../../src/hoplon/contracts/requests.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

const GIT_REPO_DIR = '/.hoplon/repo';
const FS_ROOT = '/';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Shared CI — loaded once to avoid repeated WASM loads
let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

interface TestHarness {
  checkSigDeps: CheckSignaturesDeps;
  dryRunDeps: DryRunDeps;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: VersioningAdapter;
  store: SnapshotStore;
}

async function makeHarness(): Promise<TestHarness> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();

  const snapshotDeps: CreateSnapshotDeps = {
    fs,
    versioning,
    snapshotStore: store,
    lockProvider: createAsyncMutexLockProvider(),
    emitter,
    secretScanner: createBuiltinRegexScanner(),
    engineId: 'test-engine',
    config: {
      gitRepoDir: GIT_REPO_DIR,
      fsRoot: FS_ROOT,
      manifestStorageMode: 'inline',
    },
  };

  const dryRunDeps: DryRunDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-engine',
    config: {
      fsRoot: FS_ROOT,
      gitRepoDir: GIT_REPO_DIR,
      maxFileBytes: 1024 * 1024,
      parseTimeoutMs: 5000,
      manifestSchemaVersion: 1,
    },
  };

  const checkSigDeps: CheckSignaturesDeps = {
    codeIntelligence: sharedCI,
  };

  return { checkSigDeps, dryRunDeps, snapshotDeps, fs, versioning, store };
}

/**
 * Create a real snapshot and return the snapshotRef id.
 */
async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  manifest: WritableManifest,
): Promise<{ id: string }> {
  const result = await createSnapshot(snapshotDeps, { manifest });
  return { id: result.snapshotRef.id };
}

/** Build a minimal DryRunRequest. */
function makeDryRunReq(
  snapshotRefId: string,
  proposedChanges: Array<{ file: string; content: string }>,
): DryRunRequest {
  return {
    snapshotRefId,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    proposedChanges,
  };
}

// ---------------------------------------------------------------------------
// LC3-1: matching signature → PASS
// ---------------------------------------------------------------------------

describe('LC3-1: matching signature → PASS', () => {
  it('function with matching params/return returns PASS', async () => {
    const h = await makeHarness();

    const contracts: SignatureContract[] = [
      {
        file: 'src/utils.ts',
        symbol: 'greet',
        expectedParams: [
          { name: 'name', type: 'string' },
          { name: 'age', type: 'number' },
        ],
        expectedReturn: 'string',
      },
    ];

    const result = await checkSignatures(
      h.checkSigDeps,
      [
        {
          file: 'src/utils.ts',
          content: `function greet(name: string, age: number): string { return name; }\n`,
        },
      ],
      contracts,
    );

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC3-2: mismatched param count → BLOCK with SIGNATURE_MISMATCH
// ---------------------------------------------------------------------------

describe('LC3-2: mismatched param count → SIGNATURE_MISMATCH', () => {
  it('function with wrong number of params returns BLOCK with SIGNATURE_MISMATCH', async () => {
    const h = await makeHarness();

    const contracts: SignatureContract[] = [
      {
        file: 'src/utils.ts',
        symbol: 'process',
        expectedParams: [
          { name: 'input', type: 'string' },
          { name: 'options', type: 'ProcessOptions' },
        ],
        expectedReturn: 'void',
      },
    ];

    // Proposed version only has 1 param — missing 'options'
    const result = await checkSignatures(
      h.checkSigDeps,
      [
        {
          file: 'src/utils.ts',
          content: `function process(input: string): void { return; }\n`,
        },
      ],
      contracts,
    );

    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('SIGNATURE_MISMATCH');
    if (result.violations[0].kind === 'SIGNATURE_MISMATCH') {
      expect(result.violations[0].symbol).toBe('process');
      expect(result.violations[0].expected).toContain('options');
      expect(result.violations[0].actual).not.toContain('options');
    }
  });
});

// ---------------------------------------------------------------------------
// LC3-3: generic function → UNCERTAIN with SIGNATURE_UNCERTAIN
// ---------------------------------------------------------------------------

describe('LC3-3: generic function → SIGNATURE_UNCERTAIN', () => {
  it('generic function returns UNCERTAIN with SIGNATURE_UNCERTAIN violation', async () => {
    const h = await makeHarness();

    const contracts: SignatureContract[] = [
      {
        file: 'src/utils.ts',
        symbol: 'identity',
        expectedParams: [{ name: 'value', type: 'T' }],
        expectedReturn: 'T',
      },
    ];

    const result = await checkSignatures(
      h.checkSigDeps,
      [
        {
          file: 'src/utils.ts',
          content: `function identity<T>(value: T): T { return value; }\n`,
        },
      ],
      contracts,
    );

    expect(result.status).toBe('UNCERTAIN');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0].kind).toBe('SIGNATURE_UNCERTAIN');
    if (result.violations[0].kind === 'SIGNATURE_UNCERTAIN') {
      expect(result.violations[0].symbol).toBe('identity');
      // Note must explain why comparison is uncertain
      expect(result.violations[0].note.toLowerCase()).toContain('generic');
    }
  });
});

// ---------------------------------------------------------------------------
// LC3-4: no signatureContracts → PASS (skipped)
// ---------------------------------------------------------------------------

describe('LC3-4: no signatureContracts → PASS (backward compatible)', () => {
  it('returns PASS immediately when signatureContracts is undefined', async () => {
    const h = await makeHarness();

    const result = await checkSignatures(
      h.checkSigDeps,
      [
        {
          file: 'src/utils.ts',
          content: `function anything(x: number, y: string, z: boolean): void {}\n`,
        },
      ],
      undefined,
    );

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });

  it('returns PASS immediately when signatureContracts is empty array', async () => {
    const h = await makeHarness();

    const result = await checkSignatures(
      h.checkSigDeps,
      [
        {
          file: 'src/utils.ts',
          content: `function anything(x: number): string { return ''; }\n`,
        },
      ],
      [],
    );

    expect(result.status).toBe('PASS');
    expect(result.violations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC3-5: dryRun integration — SIGNATURE_MISMATCH surfaces in AuditResult
// ---------------------------------------------------------------------------

describe('LC3-5: dryRun integration — SIGNATURE_MISMATCH propagates to AuditResult', () => {
  it('dryRun returns BLOCK when proposed change violates a signatureContract', async () => {
    const h = await makeHarness();

    // Seed the filesystem with initial file content
    await h.fs.write('src/service.ts', enc('export function connect(url: string): void { }\n'));

    // v2 manifest with signatureContracts
    const manifest: WritableManifest = {
      manifestSchemaVersion: 2,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [
        { path: 'src/service.ts', scope: { kind: 'whole_file' } },
      ],
      signatureContracts: [
        {
          file: 'src/service.ts',
          symbol: 'connect',
          expectedParams: [
            { name: 'url', type: 'string' },
            { name: 'timeout', type: 'number' },
          ],
          expectedReturn: 'void',
        },
      ],
    };

    const { id: _snapshotRefId } = await takeSnapshot(h.snapshotDeps, manifest);

    // dryRun config uses manifestSchemaVersion: 1 to bypass version mismatch for
    // this integration test; we override below to test schema v2 compatibility.
    // Note: dryRun checks record.manifest?.signatureContracts from the snapshot,
    // not from config, so the v2 signatureContracts are correctly accessed.
    const _depsWithV2: DryRunDeps = {
      ...h.dryRunDeps,
      config: {
        ...h.dryRunDeps.config,
        // manifestSchemaVersion must match — the manifest we created is v2,
        // but the store records it. dryRun accepts the stored version.
        // Since DryRunDeps.config.manifestSchemaVersion is typed as `1`,
        // we use the existing config which works via the AS-2 check
        // (schema version on the record vs engine config).
        // We keep manifestSchemaVersion: 1 to avoid SemanticError; the
        // signatureContracts are read from record.manifest directly.
        manifestSchemaVersion: 1,
      },
    };

    // The snapshot's manifest has manifestSchemaVersion: 2 but dryRunDeps
    // checks against config.manifestSchemaVersion: 1. This would normally
    // throw a SemanticError. We need to use a v1 manifest for the integration
    // test so the version check passes.
    const manifestV1: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed-v1',
      entries: [
        { path: 'src/service.ts', scope: { kind: 'whole_file' } },
      ],
      signatureContracts: [
        {
          file: 'src/service.ts',
          symbol: 'connect',
          expectedParams: [
            { name: 'url', type: 'string' },
            { name: 'timeout', type: 'number' },
          ],
          expectedReturn: 'void',
        },
      ],
    };

    // Create a fresh harness so v1 manifest snapshot doesn't conflict
    const h2 = await makeHarness();
    await h2.fs.write('src/service.ts', enc('export function connect(url: string): void { }\n'));
    const { id: snapshotId2 } = await takeSnapshot(h2.snapshotDeps, manifestV1);

    const result = await dryRun(
      h2.dryRunDeps,
      makeDryRunReq(snapshotId2, [
        {
          file: 'src/service.ts',
          // Proposed code has only 1 param — contract requires 2 (url + timeout)
          content: 'export function connect(url: string): void { }\n',
        },
      ]),
    );

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      const sigViolation = result.violations.find(
        (v) => v.kind === 'SIGNATURE_MISMATCH',
      );
      expect(sigViolation).toBeDefined();
      if (sigViolation?.kind === 'SIGNATURE_MISMATCH') {
        expect(sigViolation.symbol).toBe('connect');
        expect(sigViolation.expected).toContain('timeout');
      }
    }
  });

  it('dryRun returns PASS when signatureContracts are absent (v1 manifest)', async () => {
    const h = await makeHarness();

    await h.fs.write('src/service.ts', enc('export function connect(url: string): void { }\n'));

    // v1 manifest — no signatureContracts
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-seed',
      entries: [
        { path: 'src/service.ts', scope: { kind: 'whole_file' } },
      ],
    };

    const { id: snapshotRefId } = await takeSnapshot(h.snapshotDeps, manifest);

    const result = await dryRun(
      h.dryRunDeps,
      makeDryRunReq(snapshotRefId, [
        {
          file: 'src/service.ts',
          // Proposed code has completely different signature — but no contract to check
          content: 'export function connect(a: number, b: string, c: boolean): string { return ""; }\n',
        },
      ]),
    );

    // No signatureContracts → PASS (skipped)
    expect(result.status).toBe('PASS');
  });
});
