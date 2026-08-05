import { createHash } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';
import { getLoadablePath } from 'sqlite-vec';

import {
  createNodeSqliteVecHoplonAdapters,
  createNodeSqliteVecSemanticIndex,
} from '../src/index.js';
import { createHashingTextEmbedding } from '../../../src/hoplon/adapters/embedding/hashing.js';
import { createNoopEmbeddingCache } from '../../../src/hoplon/adapters/embeddingCache.js';
import { createNoopVectorStore } from '../../../src/hoplon/adapters/vectorStore.js';
import { createDefaultHoplonEngine } from '../../../src/hoplon/engine/factory.js';
import type {
  LexicalIndexAdapter,
  SemanticStorageProfileAdapter,
  VectorIndexAdapter,
} from '../../../src/hoplon/adapters/index.js';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

describe('node:sqlite sqlite-vec Hoplon engine binding', () => {
  it('indexes and queries through engine semanticSearch with sqlite-vec vectors', async () => {
    const databasePath = tempDatabasePath('engine');
    const engineRoot = await mkdtemp(join(tmpdir(), 'hoplon-engine-root-'));
    await mkdir(join(engineRoot, '.hoplon'), { recursive: true });
    await removeDatabase(databasePath);
    const extensionSha256 = await sha256(getLoadablePath());
    const nativeIndex = await createNodeSqliteVecSemanticIndex({
      databasePath,
      vectorDimension: 8,
      expectedExtensionSha256: extensionSha256,
    });

    try {
      const description = await nativeIndex.describe();
      expect(description).toMatchObject({
        status: 'AVAILABLE',
        semanticVectorRuntime: 'sqlite-vec-native',
        vectorAvailable: true,
      });

      const nativeAdapters = createNodeSqliteVecHoplonAdapters(nativeIndex);
      const engine = await createDefaultHoplonEngine({
        root: engineRoot,
        dbPath: join(engineRoot, '.hoplon', 'hoplon.db'),
        gitRepoDir: join(engineRoot, '.hoplon', 'repo'),
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

      await expect(
        engine.indexSemanticCorpus({
          correlationId: 'sqlite-vec-index',
          projectId: 'project-a',
          documents: [
            {
              id: 'doc-alpha',
              text: 'alpha sqlite vector runtime stores semantic embeddings',
              metadata: { path: 'src/alpha.ts', symbolName: 'alphaSearch' },
            },
            {
              id: 'doc-beta',
              text: 'beta billing ledger unrelated accounting workflow',
              metadata: { path: 'src/beta.ts', symbolName: 'billingLedger' },
            },
          ],
        }),
      ).resolves.toMatchObject({
        status: 'AVAILABLE',
        providerAvailable: true,
        indexedCount: 2,
      });

      const result = await engine.semanticSearch({
        correlationId: 'sqlite-vec-query',
        projectId: 'project-a',
        query: 'sqlite vector semantic embeddings',
        topK: 2,
      });

      expect(result).toMatchObject({
        advisory: true,
        status: 'AVAILABLE',
        providerAvailable: true,
        resultCount: 2,
      });
      expect(result.matches.some((match) => match.rankSource === 'baseline_vector'))
        .toBe(true);
      expect(result.matches.map((match) => match.id)).toContain('doc-alpha');
    } finally {
      await nativeIndex.close();
      await removeDatabase(databasePath);
      await rm(engineRoot, { recursive: true, force: true });
    }
  });
});

function tempDatabasePath(name: string): string {
  return join(tmpdir(), `hoplon-engine-sqlite-vec-${name}-${process.pid}.sqlite`);
}

async function removeDatabase(databasePath: string): Promise<void> {
  await Promise.all([
    rm(databasePath, { force: true }),
    rm(`${databasePath}-wal`, { force: true }),
    rm(`${databasePath}-shm`, { force: true }),
  ]);
}

async function sha256(file: string): Promise<string> {
  return createHash('sha256').update(await readFile(file)).digest('hex');
}
