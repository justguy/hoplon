import {
  createEmptyPortableSemanticIndexSnapshot,
  createInMemoryPortableSemanticIndexStorage,
} from './storage.js';
import {
  compareMatches,
  createPortableMaintenance,
  emptyLexicalResult,
  loadSnapshot,
  scoreDocuments,
  STORAGE_ERROR_REASON,
  tokenize,
  unavailableLexicalResult,
  unavailableVectorResult,
  VECTOR_DEGRADATION_REASON,
} from './helpers.js';
import type {
  PortableSemanticIndexAdapters,
  PortableSemanticIndexDescription,
  LexicalIndexAdapter,
  LexicalIndexDocument,
  LexicalIndexResult,
  PortableSemanticIndexOptions,
  PortableSemanticIndexScaleLimits,
  PortableSemanticIndexStorage,
  SemanticStorageProfile,
  VectorIndexAdapter,
  VectorIndexResult,
} from './types.js';

const DEFAULT_SCALE_LIMITS: PortableSemanticIndexScaleLimits = {
  maxRecommendedDocuments: 50_000,
  maxRecommendedTokensPerDocument: 20_000,
};

export function createPortableSemanticIndex(
  options: PortableSemanticIndexOptions,
): PortableSemanticIndexAdapters {
  const storage = options.storage;
  const scaleLimits = {
    maxRecommendedDocuments:
      options.maxRecommendedDocuments ?? DEFAULT_SCALE_LIMITS.maxRecommendedDocuments,
    maxRecommendedTokensPerDocument:
      options.maxRecommendedTokensPerDocument ??
      DEFAULT_SCALE_LIMITS.maxRecommendedTokensPerDocument,
  };

  const storageProfile = {
    async describe(): Promise<SemanticStorageProfile> {
      return createStorageProfile();
    },
  };

  return {
    lexicalIndex: createPortableLexicalIndex(storage),
    vectorIndex: createUnavailableVectorIndex(),
    storageProfile,
    maintenance: createPortableMaintenance(storage),
    async describe(): Promise<PortableSemanticIndexDescription> {
      const profile = await storageProfile.describe();
      return {
        runtimeProfile: 'lexical_only_degraded',
        persistenceMode: 'host_snapshot_storage',
        lexicalAvailable: true,
        vectorAvailable: false,
        nativeRuntime: false,
        storageProfile: profile,
        scaleLimits,
        degradationReasons: [...profile.degradationReasons],
      };
    },
  };
}

export {
  createEmptyPortableSemanticIndexSnapshot,
  createInMemoryPortableSemanticIndexStorage,
};
export type {
  PortableSemanticIndexAdapters,
  PortableSemanticIndexDescription,
  PortableSemanticIndexOptions,
  PortableSemanticIndexPersistenceMode,
  PortableSemanticIndexRuntimeProfile,
  PortableSemanticIndexScaleLimits,
  PortableSemanticIndexSnapshot,
  PortableSemanticIndexStorage,
  PortableSemanticIndexStoredDocument,
  PortableSourceBranchKind,
  PortableSourceCommitSnapshot,
  PortableSourceStaleState,
  PortableBranchAlias,
  PortableChunkIdentity,
  PortableLineRange,
  LexicalIndexAdapter,
  LexicalIndexDocument,
  LexicalIndexMatch,
  LexicalIndexResult,
  SemanticStorageProfile,
  VectorIndexAdapter,
  VectorIndexResult,
} from './types.js';

function createPortableLexicalIndex(
  storage: PortableSemanticIndexStorage,
): LexicalIndexAdapter {
  return {
    async upsert(
      projectId: string,
      documents: readonly LexicalIndexDocument[],
    ): Promise<LexicalIndexResult> {
      try {
        const snapshot = await loadSnapshot(storage);
        const project = snapshot.projects[projectId] ?? {};
        const updatedAtIso = new Date(0).toISOString();

        for (const document of documents) {
          project[document.id] = {
            id: document.id,
            text: document.text,
            metadata: { ...document.metadata },
            ...(document.sourceSnapshot === undefined
              ? {}
              : { sourceSnapshot: document.sourceSnapshot }),
            ...(document.branchAliases === undefined
              ? {}
              : { branchAliases: document.branchAliases }),
            ...(document.chunkIdentity === undefined
              ? {}
              : { chunkIdentity: document.chunkIdentity }),
            updatedAtIso,
          };
          delete snapshot.tombstones[projectId]?.[document.id];
        }

        snapshot.projects[projectId] = project;
        await storage.save(snapshot);

        return {
          status: documents.length === 0 ? 'EMPTY' : 'AVAILABLE',
          resultCount: documents.length,
          matches: [],
          degradationReasons: [],
        };
      } catch {
        return unavailableLexicalResult(STORAGE_ERROR_REASON);
      }
    },

    async search(
      projectId: string,
      query: string,
      topK: number,
    ): Promise<LexicalIndexResult> {
      try {
        if (topK <= 0) {
          return emptyLexicalResult();
        }

        const queryTokens = new Set(tokenize(query));
        if (queryTokens.size === 0) {
          return emptyLexicalResult();
        }

        const snapshot = await loadSnapshot(storage);
        const project = snapshot.projects[projectId];
        if (project === undefined) {
          return emptyLexicalResult();
        }

        const matches = scoreDocuments(
          project,
          snapshot.tombstones[projectId] ?? {},
          queryTokens,
        )
          .sort(compareMatches)
          .slice(0, topK);

        return {
          status: matches.length === 0 ? 'EMPTY' : 'AVAILABLE',
          resultCount: matches.length,
          matches,
          degradationReasons: [],
        };
      } catch {
        return unavailableLexicalResult(STORAGE_ERROR_REASON);
      }
    },

    async delete(
      projectId: string,
      documentIds: readonly string[],
      options?: { readonly tombstoneKind?: 'deleted' | 'ignored' | 'policy_banned' },
    ): Promise<LexicalIndexResult> {
      try {
        const snapshot = await loadSnapshot(storage);
        const project = snapshot.projects[projectId];
        const projectTombstones = snapshot.tombstones[projectId] ?? {};
        let deleted = 0;
        const updatedAtIso = new Date(0).toISOString();

        for (const documentId of documentIds) {
          projectTombstones[documentId] = {
            id: documentId,
            kind: options?.tombstoneKind ?? 'deleted',
            updatedAtIso,
          };
        }
        snapshot.tombstones[projectId] = projectTombstones;

        if (project !== undefined) {
          for (const documentId of documentIds) {
            if (project[documentId] !== undefined) {
              delete project[documentId];
              deleted += 1;
            }
          }
          snapshot.projects[projectId] = project;
        }

        await storage.save(snapshot);
        return {
          status: deleted === 0 ? 'EMPTY' : 'AVAILABLE',
          resultCount: deleted,
          matches: [],
          degradationReasons: [],
        };
      } catch {
        return unavailableLexicalResult(STORAGE_ERROR_REASON);
      }
    },
  };
}

function createUnavailableVectorIndex(): VectorIndexAdapter {
  return {
    async upsert(): Promise<VectorIndexResult> {
      return unavailableVectorResult();
    },
    async search(): Promise<VectorIndexResult> {
      return unavailableVectorResult();
    },
    async delete(): Promise<VectorIndexResult> {
      return unavailableVectorResult();
    },
  };
}

function createStorageProfile(): SemanticStorageProfile {
  return {
    kind: 'lexical_only_degraded',
    status: 'DEGRADED',
    durableLexical: true,
    durableVector: false,
    nativeRuntime: false,
    degradationReasons: [VECTOR_DEGRADATION_REASON],
  };
}
