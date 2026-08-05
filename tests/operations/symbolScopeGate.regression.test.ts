/**
 * tests/operations/symbolScopeGate.regression.test.ts — hcr-002 regression suite.
 *
 * FINDING 2: the symbol-scope PASS/BLOCK gate must be a true diff between the
 * snapshot baseline (versioning.readBlob at the snapshot gitRef) and the
 * current (auditDiff) or proposed in-memory (dryRun) state:
 *
 *   (a) Deleting a pre-existing symbol OUTSIDE the authorized scope → BLOCK.
 *       (Previously PASSed — the gate only examined the current AST.)
 *   (b) An UNCHANGED out-of-scope sibling symbol present in the file must
 *       NOT cause a BLOCK. (Previously falsely BLOCKed.)
 *
 * AGENTS.md rule: agent-facing audit evidence (sourceSlice) must never be
 * truncated — full evidence reaches the violation payload.
 *
 * dryRun must remain strictly side-effect-free (no writes, no audit rows).
 *
 * Harness mirrors tests/operations/dryRun.test.ts: memfs + real isomorphic-git
 * + real tree-sitter WASM grammars + in-memory SQLite snapshot store.
 */

import { describe, it, expect, beforeAll, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { auditDiff } from '../../src/hoplon/operations/auditDiff.js';
import type { AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
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
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';

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

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

async function makeDeps(): Promise<{
  auditDiffDeps: AuditDiffDeps;
  dryRunDeps: DryRunDeps;
  snapshotDeps: CreateSnapshotDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  versioning: VersioningAdapter;
  store: SnapshotStore;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();

  const auditDiffDeps: AuditDiffDeps = {
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

  return { auditDiffDeps, dryRunDeps, snapshotDeps, fs, versioning, store };
}

function makeManifest(symbols: string[]): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-seed',
    entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols } }],
  };
}

async function takeSnapshot(
  snapshotDeps: CreateSnapshotDeps,
  manifest: WritableManifest,
): Promise<string> {
  const result = await createSnapshot(snapshotDeps, { manifest });
  return result.snapshotRef.id;
}

const BASELINE = 'function foo() { return 1; }\nfunction bar() { return 2; }\n';

// ---------------------------------------------------------------------------
// (a) Deleting an out-of-scope pre-existing symbol must BLOCK
// ---------------------------------------------------------------------------

describe('hcr-002 (a): deleting a pre-existing out-of-scope symbol → BLOCK', () => {
  it('auditDiff BLOCKs when bar (outside scope) is deleted from disk state', async () => {
    const { auditDiffDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.js', enc(BASELINE));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    // Agent deletes bar — a symbol it was never authorized to touch.
    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));

    const result = await auditDiff(auditDiffDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/a.js'],
    });

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('out_of_scope_symbol');
      if (v.kind === 'out_of_scope_symbol') {
        expect(v.symbolName).toBe('bar');
        expect(v.changeType).toBe('removed');
        // Evidence comes from the baseline (the deleted source).
        expect(v.sourceSlice).toContain('return 2');
      }
    }
  });

  it('dryRun BLOCKs when a proposed change deletes bar (outside scope), with no side effects', async () => {
    const { dryRunDeps, snapshotDeps, fs, store } = await makeDeps();
    await fs.write('src/a.js', enc(BASELINE));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    const writeSpy = vi.spyOn(fs, 'write');
    const auditLogSpy = vi.spyOn(store, 'appendAuditLog');

    const result = await dryRun(dryRunDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      proposedChanges: [{ file: 'src/a.js', content: 'function foo() { return 1; }\n' }],
    });

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('out_of_scope_symbol');
      if (v.kind === 'out_of_scope_symbol') {
        expect(v.symbolName).toBe('bar');
        expect(v.changeType).toBe('removed');
      }
    }

    // dryRun stays strictly side-effect-free: no writes, no audit rows.
    expect(writeSpy).not.toHaveBeenCalled();
    expect(auditLogSpy).not.toHaveBeenCalled();
    writeSpy.mockRestore();
    auditLogSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// (b) Unchanged out-of-scope sibling must NOT BLOCK
// ---------------------------------------------------------------------------

describe('hcr-002 (b): unchanged out-of-scope sibling symbol → no false BLOCK', () => {
  it('auditDiff PASSes an in-scope edit when bar (outside scope) is byte-identical to baseline', async () => {
    const { auditDiffDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.js', enc(BASELINE));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    // Only foo (in scope) is modified; bar is untouched.
    await fs.write(
      'src/a.js',
      enc('function foo() { return 42; }\nfunction bar() { return 2; }\n'),
    );

    const result = await auditDiff(auditDiffDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/a.js'],
    });

    expect(result.status).toBe('PASS');
  });

  it('dryRun PASSes a proposed in-scope edit when bar (outside scope) is byte-identical to baseline', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.js', enc(BASELINE));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    const result = await dryRun(dryRunDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      proposedChanges: [
        {
          file: 'src/a.js',
          content: 'function foo() { return 42; }\nfunction bar() { return 2; }\n',
        },
      ],
    });

    expect(result.status).toBe('PASS');
  });

  it('auditDiff still BLOCKs when the out-of-scope sibling itself is modified', async () => {
    const { auditDiffDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.js', enc(BASELINE));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    // bar (outside scope) is modified alongside the in-scope foo edit.
    await fs.write(
      'src/a.js',
      enc('function foo() { return 42; }\nfunction bar() { return 99; }\n'),
    );

    const result = await auditDiff(auditDiffDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/a.js'],
    });

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(result.violations).toHaveLength(1);
      const v = result.violations[0]!;
      expect(v.kind).toBe('out_of_scope_symbol');
      if (v.kind === 'out_of_scope_symbol') {
        expect(v.symbolName).toBe('bar');
        expect(v.changeType).toBe('modified');
      }
    }
  });
});

// ---------------------------------------------------------------------------
// AGENTS.md rule: agent-facing audit evidence is never truncated
// ---------------------------------------------------------------------------

describe('hcr-002: agent-facing evidence is never truncated', () => {
  // A single out-of-scope function whose body exceeds the old 4 KiB cap.
  const BIG_BODY = `  const filler = '${'x'.repeat(8192)}';\n  return filler;\n`;
  const BIG_ADDED = `function foo() { return 1; }\nfunction bar() {\n${BIG_BODY}}\n`;

  it('auditDiff delivers the full >4KiB violating symbol source, untruncated', async () => {
    const { auditDiffDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    await fs.write('src/a.js', enc(BIG_ADDED));

    const result = await auditDiff(auditDiffDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      files: ['src/a.js'],
    });

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      const v = result.violations[0]!;
      expect(v.kind).toBe('out_of_scope_symbol');
      if (v.kind === 'out_of_scope_symbol') {
        expect(v.symbolName).toBe('bar');
        expect(v.sourceSlice.length).toBeGreaterThan(4096);
        expect(v.sourceSlice).toContain('x'.repeat(8192));
        expect(v.truncated).toBeUndefined();
      }
    }
  });

  it('dryRun delivers the full >4KiB violating symbol source, untruncated', async () => {
    const { dryRunDeps, snapshotDeps, fs } = await makeDeps();
    await fs.write('src/a.js', enc('function foo() { return 1; }\n'));
    const snapshotRefId = await takeSnapshot(snapshotDeps, makeManifest(['foo']));

    const result = await dryRun(dryRunDeps, {
      snapshotRefId,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
      proposedChanges: [{ file: 'src/a.js', content: BIG_ADDED }],
    });

    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      const v = result.violations[0]!;
      expect(v.kind).toBe('out_of_scope_symbol');
      if (v.kind === 'out_of_scope_symbol') {
        expect(v.symbolName).toBe('bar');
        expect(v.sourceSlice.length).toBeGreaterThan(4096);
        expect(v.sourceSlice).toContain('x'.repeat(8192));
        expect(v.truncated).toBeUndefined();
      }
    }
  });
});
