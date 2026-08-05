/**
 * tests/transport/http.snapshotEvidence.test.ts — packaged HTTP route proof
 * for the t-081 snapshot-evidence surface.
 *
 * Drives the shipped `/session/snapshotEvidence` route over a real in-process
 * engine stack (memfs + isomorphic-git + sql.js snapshot store) so the
 * packaged HTTP surface is proved separately from the session-level composer.
 */

import { describe, expect, it } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { SessionSnapshotEvidenceResultSchema } from '../../src/hoplon/session/transportContracts.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import type { FastifyInstance } from 'fastify';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

const ENCODER = new TextEncoder();
const FS_ROOT = '/';
const GIT_REPO_DIR = '/.hoplon/repo';

function manifestFor(path: string): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'proj-http-t081',
    runId: 'run-http-t081',
    correlationId: 'corr-http-t081',
    entries: [{ path, scope: { kind: 'whole_file' } }],
  };
}

async function buildServer(): Promise<{
  fs: ReturnType<typeof createMemFsAdapter>;
  server: FastifyInstance;
  dispose: () => Promise<void>;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const snapshotStore = await createIsolatedTestStore();
  const lockProvider = createAsyncMutexLockProvider();
  const emitter = createMemoryEmitter();
  const codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: GRAMMARS_DIR,
  });
  const secretScanner = createBuiltinRegexScanner();
  const engine = await createHoplonEngine(
    {
      fs,
      versioning,
      snapshotStore,
      lockProvider,
      emitter,
      codeIntelligence,
      secretScanner,
    },
    {
      engineId: 'http-t081-engine',
      fsRoot: FS_ROOT,
      gitRepoDir: GIT_REPO_DIR,
    },
  );
  const registry = createSessionRegistry({
    engine,
    fs,
    codeIntelligence,
    lockProvider,
    versioning,
    snapshotStore,
    gitRepoDir: GIT_REPO_DIR,
  });
  const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });

  return {
    fs,
    server,
    dispose: async () => {
      await server.close();
      registry.dispose();
    },
  };
}

async function post<T>(
  server: FastifyInstance,
  url: string,
  payload: unknown,
): Promise<{ statusCode: number; body: T }> {
  const response = await server.inject({ method: 'POST', url, payload });
  return {
    statusCode: response.statusCode,
    body: JSON.parse(response.body) as T,
  };
}

describe('HTTP /session/snapshotEvidence (t-081)', () => {
  it('round-trips provenance and live diff over the packaged route', async () => {
    const { fs, server, dispose } = await buildServer();
    const filePath = 'src/foo.ts';
    await fs.write(
      filePath,
      ENCODER.encode('export function foo(): string { return "hello"; }\n'),
    );

    try {
      const start = await post<{ session: { sessionId: string } }>(
        server,
        '/session/start',
        { manifest: manifestFor(filePath) },
      );
      const sessionId = start.body.session.sessionId;

      await post(server, '/session/preflight', { sessionId });
      const snapshot = await post<{
        state: string;
        data: { snapshotRef: { id: string } };
      }>(server, '/session/createSnapshot', { sessionId });
      expect(snapshot.statusCode).toBe(200);
      expect(snapshot.body.state).toBe('snapshotted');
      const snapshotRefId = snapshot.body.data.snapshotRef.id;

      await fs.write(
        filePath,
        ENCODER.encode('export function foo(): string { return "world"; }\n'),
      );

      const provenance = await post<{
        state: string;
        data: { evidence: unknown };
      }>(server, '/session/snapshotEvidence', {
        sessionId,
        request: { kind: 'provenance', snapshotRefId },
      });
      expect(provenance.statusCode).toBe(200);
      expect(provenance.body.state).toBe('snapshotted');
      const parsedProvenance = SessionSnapshotEvidenceResultSchema.safeParse(
        provenance.body.data.evidence,
      );
      expect(parsedProvenance.success).toBe(true);
      if (!parsedProvenance.success) throw new Error('unreachable');
      expect(parsedProvenance.data.kind).toBe('provenance');
      if (parsedProvenance.data.kind !== 'provenance') throw new Error('unreachable');
      expect(parsedProvenance.data.snapshotRefId).toBe(snapshotRefId);
      expect(parsedProvenance.data.projectId).toBe('proj-http-t081');
      expect(parsedProvenance.data.runId).toBe('run-http-t081');
      expect(parsedProvenance.data.status).toBe('committed');
      expect(parsedProvenance.data.snapshotGitCommitSha).toMatch(/^[0-9a-f]{40}$/);

      const diff = await post<{
        state: string;
        data: { evidence: unknown };
      }>(server, '/session/snapshotEvidence', {
        sessionId,
        request: {
          kind: 'diff',
          fromSnapshotRefId: snapshotRefId,
          to: 'live',
        },
      });
      expect(diff.statusCode).toBe(200);
      expect(diff.body.state).toBe('snapshotted');
      const parsedDiff = SessionSnapshotEvidenceResultSchema.safeParse(
        diff.body.data.evidence,
      );
      expect(parsedDiff.success).toBe(true);
      if (!parsedDiff.success) throw new Error('unreachable');
      expect(parsedDiff.data.kind).toBe('diff');
      if (parsedDiff.data.kind !== 'diff') throw new Error('unreachable');
      const fileDiff = parsedDiff.data.files.find((entry) => entry.filepath === filePath);
      expect(fileDiff?.status).toBe('modified');
      expect(fileDiff?.unifiedDiff).toContain(
        '-export function foo(): string { return "hello"; }',
      );
      expect(fileDiff?.unifiedDiff).toContain(
        '+export function foo(): string { return "world"; }',
      );

      const lineProvenance = await post<{
        state: string;
        data: { evidence: unknown };
      }>(server, '/session/snapshotEvidence', {
        sessionId,
        request: {
          kind: 'line_provenance',
          snapshotRefId,
          file: filePath,
          target: { kind: 'line_range', lineRange: { startLine: 1, endLine: 1 } },
        },
      });
      expect(lineProvenance.statusCode).toBe(200);
      expect(lineProvenance.body.state).toBe('snapshotted');
      const parsedLineProvenance = SessionSnapshotEvidenceResultSchema.safeParse(
        lineProvenance.body.data.evidence,
      );
      expect(parsedLineProvenance.success).toBe(true);
      if (!parsedLineProvenance.success) throw new Error('unreachable');
      expect(parsedLineProvenance.data.kind).toBe('line_provenance');
      if (parsedLineProvenance.data.kind !== 'line_provenance') {
        throw new Error('unreachable');
      }
      expect(parsedLineProvenance.data.file).toBe(filePath);
      expect(parsedLineProvenance.data.snapshotRefId).toBe(snapshotRefId);
      expect(parsedLineProvenance.data.commit.commitId).toBe(
        parsedLineProvenance.data.snapshotGitCommitSha,
      );
    } finally {
      await dispose();
    }
  }, 60_000);
});
