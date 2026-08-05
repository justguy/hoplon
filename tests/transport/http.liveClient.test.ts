/**
 * tests/transport/http.liveClient.test.ts — live client/server HTTP proof.
 *
 * Proves `createRemoteHoplonEngine` against a real listening Hoplon HTTP
 * server rather than a mock-fetch transport.
 */

import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';
import { getLoadablePath } from 'sqlite-vec';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createRemoteHoplonEngine } from '../../src/hoplon/transport/http/client.js';
import { createDefaultHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createHashingTextEmbedding } from '../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbeddingCache } from '../../src/hoplon/adapters/embeddingCache.js';
import { createNoopVectorStore } from '../../src/hoplon/adapters/vectorStore.js';
import { createNodeFsAdapter } from '../../src/hoplon/adapters/fs/node.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createNoopEmitter } from '../../src/hoplon/adapters/emitter/noop.js';
import {
  buildSemanticIndexBoundaryDocuments,
} from '../../src/hoplon/operations/semanticIndexBoundary.js';
import {
  buildIndexSemanticCorpusRequestFromBoundary,
} from '../../src/hoplon/operations/semanticProjectCorpus.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type {
  LexicalIndexAdapter,
  SemanticStorageProfileAdapter,
  VectorIndexAdapter,
} from '../../src/hoplon/adapters/index.js';
import type {
  SeeCodebaseEnvelope,
  SeeCodebaseRequest,
} from '../../src/hoplon/contracts/seeCodebase.js';
import {
  createNodeSqliteVecHoplonAdapters,
  createNodeSqliteVecSemanticIndex,
} from '../../packages/vector-store-sqlite-vec/src/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

describe('createRemoteHoplonEngine live HTTP round-trip (t-069)', () => {
  it('round-trips GET /health and POST /seeCodebase against a listening server', async () => {
    const envelope: SeeCodebaseEnvelope = {
      ok: true,
      data: {
        results: [
          {
            kind: 'raw_file',
            path: 'src/foo.ts',
            bytes: 22,
            content: 'export const foo = 1;\n',
            truncated: false,
            // t-078: per-result content provenance surfaces verbatim on the
            // packaged HTTP transport.
            readProvenance: {
              kind: 'live_filesystem',
              workspaceRoot: '/repo',
              filePath: 'src/foo.ts',
              readAtIso: '2026-04-22T00:00:00.000Z',
            },
          },
        ],
      },
      provenance: {
        selectedPath: 'raw',
        routingReason: 'read_exact_text → raw',
        routingFactors: {
          intent: 'read_exact_text',
          fileKindSupport: 'not_applicable',
          modeRequested: 'raw',
          strict: false,
        },
        primitivesUsed: ['rawFileRead'],
        fallbackOccurred: false,
        fallbackBlockedByStrict: false,
        truncated: false,
        metrics: { latencyMs: 1, bytesReturned: 22 },
        correlationId: 'corr-live-client',
        engineId: 'live-http-engine',
      },
    };

    const health = vi.fn(async () => ({
      engineId: 'live-http-engine',
      adapters: {
        fs: 'ok',
        versioning: 'ok',
        snapshotStore: 'ok',
        lockProvider: 'ok',
        emitter: 'ok',
        codeIntelligence: 'ok',
        secretScanner: 'ok',
        staticAnalysis: 'ok',
      },
      semantic: {
        status: 'UNAVAILABLE',
        capabilityClass: 'seam_only',
        runtimeProfile: 'noop',
        persistenceMode: 'process_local_overlay',
        adapters: {
          embedding: 'noop',
          vectorStore: 'noop',
          embeddingCache: 'noop',
          semanticIndexStore: 'noop',
          lexicalIndex: 'noop',
          vectorIndex: 'noop',
          semanticStorageProfile: 'noop',
        },
        embedding: { modelStatus: 'missing', artifactStatus: 'missing' },
        runtimeArtifacts: { nativeExtensionStatus: 'unavailable' },
        cache: { reachable: false },
        index: { reachable: false },
        overlays: {
          activeOverlayCount: 0,
          reapedOverlayCount: 0,
          documentCount: 0,
          vectorCount: 0,
          maskCount: 0,
        },
        tombstones: { reachable: false },
        degradationReasons: [],
      },
      uptimeMs: 1,
    }));
    const seeCodebase = vi.fn(async (_req: SeeCodebaseRequest) => envelope);
    const server = await createHoplonHttpServer({
      engine: { health, seeCodebase } as unknown as HoplonEngine,
    });
    await server.listen({ host: '127.0.0.1', port: 0 });

    try {
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const engine = createRemoteHoplonEngine({
        baseUrl: `http://127.0.0.1:${address.port}`,
      });

      const healthResult = await engine.health();
      expect(healthResult.engineId).toBe('live-http-engine');
      expect(healthResult.adapters.fs).toBe('ok');
      expect(health).toHaveBeenCalledOnce();

      const request: SeeCodebaseRequest = {
        projectId: 'proj-live-client',
        runId: 'run-live-client',
        correlationId: 'corr-live-client',
        intent: 'read_exact_text',
        targets: [{ kind: 'file', path: 'src/foo.ts' }],
        mode: 'raw',
      };
      const result = await engine.seeCodebase(request);
      expect(result).toEqual(envelope);
      expect(seeCodebase).toHaveBeenCalledOnce();
      expect(seeCodebase.mock.calls[0]?.[0]).toMatchObject(request);
      expect(seeCodebase.mock.calls[0]?.[0]).toEqual(
        expect.objectContaining({
          includeProvenance: true,
          strict: false,
        }),
      );
    } finally {
      await server.close();
    }
  }, 30_000);

  it('indexes workspace files and queries them through a live HTTP semantic runtime', async () => {
    const root = await mkdtemp(join(tmpdir(), 'hoplon-live-http-semantic-'));
    const databasePath = join(root, '.hoplon', 'semantic-index.sqlite');
    await mkdir(join(root, '.hoplon'), { recursive: true });
    await mkdir(join(root, 'src'), { recursive: true });
    await writeFile(
      join(root, 'src', 'alpha.ts'),
      'export function alphaSearch() { return "sqlite vector semantic runtime"; }\n',
    );
    await writeFile(
      join(root, 'src', 'beta.ts'),
      'export function billingLedger() { return "invoice accounting workflow"; }\n',
    );
    const nativeIndex = await createNodeSqliteVecSemanticIndex({
      databasePath,
      vectorDimension: 8,
      expectedExtensionSha256: await sha256(getLoadablePath()),
    });
    let server: Awaited<ReturnType<typeof createHoplonHttpServer>> | null = null;

    try {
      const nativeAdapters = createNodeSqliteVecHoplonAdapters(nativeIndex);
      const engine = await createDefaultHoplonEngine({
        root,
        dbPath: join(root, '.hoplon', 'hoplon.db'),
        gitRepoDir: join(root, '.hoplon', 'repo'),
        grammarsDir: GRAMMARS_DIR,
        semanticRuntime: {
          embedding: createHashingTextEmbedding({ dimensions: 8 }),
          vectorStore: createNoopVectorStore(),
          embeddingCache: createNoopEmbeddingCache(),
          lexicalIndex: nativeAdapters.lexicalIndex as LexicalIndexAdapter,
          vectorIndex: nativeAdapters.vectorIndex as VectorIndexAdapter,
          semanticStorageProfile:
            nativeAdapters.semanticStorageProfile as SemanticStorageProfileAdapter,
        },
      });
      server = await createHoplonHttpServer({ engine });
      await server.listen({ host: '127.0.0.1', port: 0 });
      const address = server.server.address();
      if (address === null || typeof address !== 'object') {
        throw new Error('no address');
      }
      const remote = createRemoteHoplonEngine({
        baseUrl: `http://127.0.0.1:${address.port}`,
      });
      const fs = createNodeFsAdapter({ root });
      const boundary = await buildSemanticIndexBoundaryDocuments({
        fs,
        versioning: createIsomorphicGitVersioning({ fs }),
        emitter: createNoopEmitter(),
        engineId: 'live-http-semantic-engine',
        root,
      }, {
        projectId: 'project-live-semantic',
        correlationId: 'corr-live-semantic-index',
        fsRootIdentityHash: 'sha256:live-http-root',
        candidateFiles: ['src/alpha.ts', 'src/beta.ts'],
      });
      const corpus = buildIndexSemanticCorpusRequestFromBoundary(boundary);
      expect(corpus.request).not.toBeNull();

      const indexResult = await remote.indexSemanticCorpus(corpus.request!);
      expect(indexResult).toMatchObject({
        status: 'AVAILABLE',
        providerAvailable: true,
        indexedCount: 2,
      });

      const searchResult = await remote.semanticSearch({
        projectId: 'project-live-semantic',
        correlationId: 'corr-live-semantic-query',
        query: 'sqlite vector semantic runtime',
        topK: 2,
      });

      expect(searchResult).toMatchObject({
        advisory: true,
        status: 'AVAILABLE',
        providerAvailable: true,
      });
      expect(searchResult.matches.map((match) => match.id)).toContain('src/alpha.ts');
      expect(searchResult.matches.some((match) => match.rankSource === 'baseline_vector'))
        .toBe(true);
    } finally {
      if (server !== null) await server.close();
      await nativeIndex.close();
      await rm(root, { recursive: true, force: true });
    }
  }, 30_000);
});

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
