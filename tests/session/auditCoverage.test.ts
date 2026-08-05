/**
 * tests/session/auditCoverage.test.ts — hcr-005 Finding 8: derived audit
 * coverage.
 *
 * The audited file set must be DERIVED, not merely caller-declared:
 * union of (a) files the session wrote via applyEdits, (b) files declared
 * via markEdited, and (c) post-snapshot workspace files discovered through
 * the fs adapter probed against the mcr-008 snapshot presence-evidence seam
 * (files present now but not present at snapshot time, minus the allowlist
 * and the Hoplon-internal gitRepoDir subtree).
 *
 * Core regression: markEdited([]) + a smuggled post-snapshot workspace file
 * must NOT reach audited_pass with zero checked files — the discovered file
 * flows into engine.auditDiff and produces the appropriate verdict. When
 * presence evidence is unavailable (legacy rows, unwired seams) the session
 * falls back to declared+written coverage and marks the audit evidence as
 * partial instead of silently passing.
 */

import { describe, it, expect } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import type { SnapshotStore, SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { makeMockEngine, MANIFEST, PASS_AUDIT, SNAPSHOT_REF_ID } from './helpers.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function recordFor(presencePaths: string[] | null): SnapshotRecord {
  return {
    id: SNAPSHOT_REF_ID,
    manifestSchemaVersion: 1,
    engineId: 'mock-engine',
    projectId: MANIFEST.projectId,
    runId: MANIFEST.runId,
    correlationId: MANIFEST.correlationId,
    status: 'committed',
    statusReason: null,
    gitRef: null,
    manifest: MANIFEST,
    createdAt: '2026-04-14T00:00:00Z',
    ttlExpires: null,
    replicaIds: [],
    presencePaths,
  };
}

/** Mock auditDiff: BLOCK with one uncontracted_file violation per input file. */
function capturingAuditDiff(captured: { files: string[] | null }) {
  return async (req: { files: readonly string[] }): Promise<AuditResult> => {
    captured.files = [...req.files];
    if (req.files.length === 0) return PASS_AUDIT;
    return {
      status: 'BLOCK',
      correlationId: 'corr-session-1',
      auditSchemaVersion: 1,
      violations: req.files.map((path) => ({
        kind: 'uncontracted_file' as const,
        path,
        firstChangedLine: 0,
        sourceSlice: '',
        message: 'uncontracted file mutation',
        correction: 'Revert this file.',
      })),
    };
  };
}

async function buildMockBundle(opts: {
  presencePaths: string[] | null;
  putRecord?: boolean;
}): Promise<{
  fs: HoplonFsAdapter;
  snapshotStore: SnapshotStore;
  captured: { files: string[] | null };
}> {
  const fs = createMemFsAdapter();
  await fs.write('src/foo.ts', enc('export const foo = 1;\n'));
  const snapshotStore = await createIsolatedTestStore();
  if (opts.putRecord !== false) {
    await snapshotStore.put(recordFor(opts.presencePaths));
  }
  return { fs, snapshotStore, captured: { files: null } };
}

describe('session.audit derived coverage (hcr-005 Finding 8)', () => {
  it('REGRESSION: markEdited([]) + smuggled post-snapshot file cannot reach audited_pass with zero coverage', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: ['src/foo.ts'],
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
    });
    await session.preflight();
    await session.createSnapshot();

    // Smuggle an uncontracted file into the workspace AFTER the snapshot.
    await fs.write('src/evil.ts', enc('export const evil = 666;\n'));

    // Caller declares nothing changed.
    await session.markEdited([]);
    const result = await session.audit();

    // The discovered file flowed into the audit input …
    expect(captured.files).toEqual(['src/evil.ts']);
    // … and produced the appropriate verdict — NOT audited_pass on zero files.
    expect(result.status).toBe('BLOCK');
    expect(session.state).toBe('audited_block');
    expect(result.coverage).toEqual({
      mode: 'derived',
      declaredFileCount: 0,
      discoveredPostSnapshotFiles: ['src/evil.ts'],
      partialReason: null,
    });
  });

  it('unions discovered files with declared files (sorted, deduplicated)', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: ['src/foo.ts'],
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
    });
    await session.preflight();
    await session.createSnapshot();
    await fs.write('src/evil.ts', enc('export const evil = 666;\n'));
    await fs.write('src/foo.ts', enc('export const foo = 2;\n'));

    await session.markEdited(['src/foo.ts']);
    await session.audit();

    expect(captured.files).toEqual(['src/evil.ts', 'src/foo.ts']);
  });

  it('excludes allowlisted trees and the gitRepoDir subtree from discovery', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: ['src/foo.ts'],
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
      gitRepoDir: 'engine-repo',
    });
    await session.preflight();
    await session.createSnapshot();

    await fs.write('src/evil.ts', enc('export const evil = 666;\n'));
    await fs.write('node_modules/pkg/index.js', enc('module.exports = 1;\n'));
    await fs.write('.git/hooks/post-commit', enc('#!/bin/sh\n'));
    await fs.write('.hoplon/hoplon.db-journal', enc('journal'));
    await fs.write('engine-repo/HEAD', enc('ref: refs/heads/main\n'));

    await session.markEdited([]);
    const result = await session.audit();

    expect(captured.files).toEqual(['src/evil.ts']);
    expect(result.coverage?.discoveredPostSnapshotFiles).toEqual(['src/evil.ts']);
  });

  it('legacy snapshot row (no presence evidence) falls back to declared coverage marked partial', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: null,
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
    });
    await session.preflight();
    await session.createSnapshot();
    await fs.write('src/evil.ts', enc('export const evil = 666;\n'));

    await session.markEdited([]);
    const result = await session.audit();

    // No fabricated discovery — but the coverage gap is marked, not silent.
    expect(captured.files).toEqual([]);
    expect(result.coverage).toEqual({
      mode: 'declared_only',
      declaredFileCount: 0,
      discoveredPostSnapshotFiles: [],
      partialReason: 'presence_evidence_missing',
    });
  });

  it('missing snapshot record falls back to declared coverage marked partial', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: null,
      putRecord: false,
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
    });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited([]);
    const result = await session.audit();

    expect(result.coverage?.mode).toBe('declared_only');
    expect(result.coverage?.partialReason).toBe('snapshot_record_missing');
  });

  it('unwired fs seam falls back to declared coverage marked partial (declared files unchanged)', async () => {
    const captured: { files: string[] | null } = { files: null };
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({ engine, manifest: MANIFEST });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    const result = await session.audit();

    expect(captured.files).toEqual(['src/foo.ts']);
    expect(result.coverage).toEqual({
      mode: 'declared_only',
      declaredFileCount: 1,
      discoveredPostSnapshotFiles: [],
      partialReason: 'fs_not_wired',
    });
  });

  it('unwired snapshotStore seam falls back to declared coverage marked partial', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', enc('export const foo = 1;\n'));
    const captured: { files: string[] | null } = { files: null };
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited([]);
    const result = await session.audit();

    expect(result.coverage?.mode).toBe('declared_only');
    expect(result.coverage?.partialReason).toBe('snapshot_store_not_wired');
  });
});

describe('session.audit derived coverage — configured revertAllowlist threading (hcr-009)', () => {
  it('trees under a custom revertAllowlist entry are excluded from discovery; others still flow', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: ['src/foo.ts'],
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
      // Mirrors an engine configured with a custom HoplonEngineConfig
      // .revertAllowlist that adds 'dist/**' to the defaults.
      revertAllowlist: ['.git/**', 'node_modules/**', '.hoplon/**', 'dist/**'],
    });
    await session.preflight();
    await session.createSnapshot();

    // Post-snapshot: one file in a revert-allowlisted tree, one smuggled file.
    await fs.write('dist/bundle.js', enc('generated\n'));
    await fs.write('src/evil.ts', enc('export const evil = 666;\n'));

    await session.markEdited([]);
    const result = await session.audit();

    // dist/** shares revert's source of truth: revert leaves it alone, so
    // audit coverage must not feed it to auditDiff as uncontracted either.
    expect(captured.files).toEqual(['src/evil.ts']);
    expect(result.coverage).toEqual({
      mode: 'derived',
      declaredFileCount: 0,
      discoveredPostSnapshotFiles: ['src/evil.ts'],
      partialReason: null,
    });
  });

  it('without threading, dist/** is discovered — the default allowlist stays byte-identical', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: ['src/foo.ts'],
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
    });
    await session.preflight();
    await session.createSnapshot();
    await fs.write('dist/bundle.js', enc('generated\n'));

    await session.markEdited([]);
    const result = await session.audit();

    expect(captured.files).toEqual(['dist/bundle.js']);
    expect(result.coverage?.discoveredPostSnapshotFiles).toEqual(['dist/bundle.js']);
  });

  it('a custom revertAllowlist REPLACES the default: un-listed default trees are discovered again', async () => {
    const { fs, snapshotStore, captured } = await buildMockBundle({
      presencePaths: ['src/foo.ts'],
    });
    const engine = makeMockEngine({ auditDiff: capturingAuditDiff(captured) });
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      snapshotStore,
      // Engine configured with only '.git/**' — node_modules is NOT
      // revert-allowlisted, so revert would delete uncontracted files there
      // and audit coverage must surface them too (walk must not prune it).
      revertAllowlist: ['.git/**'],
    });
    await session.preflight();
    await session.createSnapshot();
    await fs.write('node_modules/pkg/index.js', enc('module.exports = 1;\n'));
    await fs.write('.git/hooks/post-commit', enc('#!/bin/sh\n'));

    await session.markEdited([]);
    const result = await session.audit();

    expect(captured.files).toEqual(['node_modules/pkg/index.js']);
    expect(result.coverage?.discoveredPostSnapshotFiles).toEqual([
      'node_modules/pkg/index.js',
    ]);
  });
});

describe('session.audit derived coverage — real engine end-to-end', () => {
  const FS_ROOT = '/';
  const GIT_REPO_DIR = '/.hoplon/repo';

  function manifestFor(path: string): WritableManifest {
    return {
      manifestSchemaVersion: 1,
      projectId: 'proj-hcr005',
      runId: `run-hcr005-${Date.now()}`,
      correlationId: 'corr-hcr005',
      entries: [{ path, scope: { kind: 'whole_file' } }],
    };
  }

  it('smuggled workspace file is discovered from real presence evidence and BLOCKs the audit', async () => {
    const fs = createMemFsAdapter();
    const versioning = createIsomorphicGitVersioning({ fs });
    const snapshotStore: SnapshotStore = await createIsolatedTestStore();
    const engine = await createHoplonEngine(
      {
        fs,
        versioning,
        snapshotStore,
        lockProvider: createAsyncMutexLockProvider(),
        emitter: createMemoryEmitter(),
        codeIntelligence: await createTreeSitterIntelligence({
          grammarsDir: GRAMMARS_DIR,
        }),
        secretScanner: createBuiltinRegexScanner(),
      },
      { engineId: 'hcr005-engine', fsRoot: FS_ROOT, gitRepoDir: GIT_REPO_DIR },
    );
    const filePath = 'src/foo.ts';
    await fs.write(filePath, enc('export function foo(): string { return "hello"; }\n'));

    const session = createHoplonEditSession({
      engine,
      manifest: manifestFor(filePath),
      fs,
      snapshotStore,
      gitRepoDir: GIT_REPO_DIR,
    });
    await session.preflight();
    await session.createSnapshot();

    // Smuggle an uncontracted file after the snapshot; declare nothing.
    await fs.write('src/smuggled.ts', enc('export const evil = 666;\n'));
    await session.markEdited([]);

    const result = await session.audit();
    expect(session.state).toBe('audited_block');
    expect(result.status).toBe('BLOCK');
    if (result.status === 'BLOCK') {
      expect(
        result.violations.some(
          (v) => v.kind === 'uncontracted_file' && v.path === 'src/smuggled.ts',
        ),
      ).toBe(true);
    }
    expect(result.coverage?.mode).toBe('derived');
    expect(result.coverage?.discoveredPostSnapshotFiles).toContain('src/smuggled.ts');
  }, 30_000);
});
