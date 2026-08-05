/**
 * tests/operations/t116DtoRedactionBoundary.test.ts - t-116 DTO evidence
 * classification proof.
 *
 * Verifies the key host boundary: AuditResult remains content-bearing proof,
 * while hoplon_audit_log and HoplonEvent stay H13-safe operational telemetry.
 */

import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { auditDiff, type AuditDiffDeps } from '../../src/hoplon/operations/auditDiff.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { SnapshotRecord } from '../../src/hoplon/adapters/snapshotStore.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { hashManifest } from '../../src/hoplon/util/hashManifest.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let codeIntelligence: CodeIntelligenceAdapter;

beforeAll(async () => {
  codeIntelligence = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function encode(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

async function seedSnapshot(
  store: Awaited<ReturnType<typeof createIsolatedTestStore>>,
  manifest: WritableManifest,
): Promise<string> {
  const id = hashManifest(manifest);
  const record: SnapshotRecord = {
    id,
    manifestSchemaVersion: 1,
    engineId: 't116-engine',
    projectId: manifest.projectId,
    runId: manifest.runId,
    correlationId: manifest.correlationId,
    status: 'committed',
    statusReason: null,
    // null → empty-baseline fallback; a fake ref would fail closed (hcr-009).
    gitRef: null,
    manifest,
    createdAt: '2026-04-29T00:00:00.000Z',
    ttlExpires: null,
    replicaIds: [],
  };
  await store.put(record);
  return id;
}

describe('t-116 DTO redaction boundary', () => {
  it('keeps sourceSlice in AuditResult but logs only kind strings and counts', async () => {
    const sentinel = 'T116_SOURCE_SLICE_SENTINEL';
    const fs = createMemFsAdapter();
    const store = await createIsolatedTestStore();
    const emitter = createMemoryEmitter();
    const manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-t116',
      runId: 'run-t116',
      correlationId: 'corr-t116-seed',
      entries: [{ path: 'src/a.js', scope: { kind: 'symbols', symbols: ['foo'] } }],
    };
    const snapshotRefId = await seedSnapshot(store, manifest);
    await fs.write(
      'src/a.js',
      encode(`function foo() { return 1; }\nfunction bar() { return "${sentinel}"; }\n`),
    );

    const deps: AuditDiffDeps = {
      fs,
      versioning: createIsomorphicGitVersioning({ fs }),
      snapshotStore: store,
      codeIntelligence,
      emitter,
      engineId: 't116-engine',
      config: {
        fsRoot: '/',
        gitRepoDir: '/.hoplon/repo',
        maxFileBytes: 1024 * 1024,
        parseTimeoutMs: 5000,
        manifestSchemaVersion: 1,
      },
    };

    const result = await auditDiff(deps, {
      snapshotRefId,
      projectId: 'proj-t116',
      runId: 'run-t116',
      correlationId: 'corr-t116',
      files: ['src/a.js'],
    });

    expect(result.status).toBe('BLOCK');
    expect(JSON.stringify(result)).toContain(sentinel);

    const rows = await store.findAuditLogByProjectAndRun('proj-t116', 'run-t116');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.operation).toBe('AUDIT_DIFF');
    expect(rows[0]?.result).toBe('BLOCK');
    expect(rows[0]?.violationCount).toBe(1);
    expect(rows[0]?.violationKinds).toEqual(['out_of_scope_symbol']);
    expect(JSON.stringify(rows)).not.toContain(sentinel);
    expect(JSON.stringify(rows)).not.toContain('function bar');

    for (const event of emitter.getEvents()) {
      expect(() => assertEventIsContentFree(event)).not.toThrow();
    }
    expect(JSON.stringify(emitter.getEvents())).not.toContain(sentinel);
  });
});
