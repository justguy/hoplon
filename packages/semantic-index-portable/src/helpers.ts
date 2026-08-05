import type {
  LexicalIndexDocument,
  LexicalIndexMatch,
  LexicalIndexResult,
  PortableSemanticIndexMaintenanceResult,
  PortableSemanticIndexSnapshot,
  PortableSemanticIndexStorage,
  VectorIndexResult,
} from './types.js';
import {
  clonePortableSemanticIndexSnapshot,
  createEmptyPortableSemanticIndexSnapshot,
} from './storage.js';

export const VECTOR_DEGRADATION_REASON =
  'lexical_only_degraded_vector_runtime_not_bound';
export const STORAGE_ERROR_REASON = 'portable_semantic_index_storage_error';

export async function loadSnapshot(
  storage: PortableSemanticIndexStorage,
): Promise<PortableSemanticIndexSnapshot> {
  const snapshot = await storage.load();
  return snapshot === null
    ? createEmptyPortableSemanticIndexSnapshot()
    : clonePortableSemanticIndexSnapshot(snapshot);
}

export function emptyLexicalResult(): LexicalIndexResult {
  return {
    status: 'EMPTY',
    resultCount: 0,
    matches: [],
    degradationReasons: [],
  };
}

export function unavailableLexicalResult(reason: string): LexicalIndexResult {
  return {
    status: 'UNAVAILABLE',
    resultCount: 0,
    matches: [],
    degradationReasons: [reason],
  };
}

export function unavailableVectorResult(): VectorIndexResult {
  return {
    status: 'UNAVAILABLE',
    resultCount: 0,
    matches: [],
    degradationReasons: [VECTOR_DEGRADATION_REASON],
  };
}

export function scoreDocuments(
  documents: Record<string, LexicalIndexDocument>,
  tombstones: PortableSemanticIndexSnapshot['tombstones'][string],
  queryTokens: ReadonlySet<string>,
): LexicalIndexMatch[] {
  const matches: LexicalIndexMatch[] = [];
  for (const document of Object.values(documents)) {
    const tombstone = tombstones[document.id];
    if (tombstone?.kind === 'ignored' || tombstone?.kind === 'policy_banned') {
      continue;
    }
    const documentTokens = new Set(tokenize(document.text));
    let overlap = 0;
    for (const token of queryTokens) {
      if (documentTokens.has(token)) overlap += 1;
    }
    if (overlap > 0) {
      matches.push({
        id: document.id,
        score: overlap / Math.sqrt(queryTokens.size * documentTokens.size),
        metadata: { ...document.metadata },
      });
    }
  }
  return matches;
}

export function compareMatches(left: LexicalIndexMatch, right: LexicalIndexMatch): number {
  if (right.score !== left.score) return right.score - left.score;
  return left.id.localeCompare(right.id);
}

export function tokenize(text: string): string[] {
  return text
    .toLocaleLowerCase('en-US')
    .split(/[^a-z0-9_]+/u)
    .filter((token) => token.length > 0);
}

export function createPortableMaintenance(storage: PortableSemanticIndexStorage) {
  return {
    async gc(opts: {
      readonly semanticCache?: boolean;
      readonly semanticOverlays?: boolean;
      readonly semanticTombstones?: boolean;
    }): Promise<PortableSemanticIndexMaintenanceResult> {
      try {
        const snapshot = await loadSnapshot(storage);
        let tombstonesDeleted = 0;
        if (opts.semanticTombstones === true) {
          for (const project of Object.values(snapshot.tombstones)) {
            tombstonesDeleted += Object.keys(project).length;
          }
          await storage.save({ ...snapshot, tombstones: {} });
        } else {
          await storage.save(snapshot);
        }
        return {
          status: 'AVAILABLE',
          cacheEntriesDeleted: 0,
          overlaysReaped: 0,
          tombstonesDeleted,
          degradationReasons: [],
        };
      } catch {
        return {
          status: 'UNAVAILABLE',
          cacheEntriesDeleted: 0,
          overlaysReaped: 0,
          tombstonesDeleted: 0,
          degradationReasons: [STORAGE_ERROR_REASON],
        };
      }
    },
  };
}
