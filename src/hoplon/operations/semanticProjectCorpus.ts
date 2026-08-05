import type {
  IndexSemanticCorpusRequest,
  SemanticCorpusDocument,
  SemanticEmbeddingCachePolicy,
  SemanticIndexingScope,
} from '../contracts/semanticSearch.js';
import type { SemanticIndexBoundaryResult } from './semanticIndexBoundary.js';

export interface ProjectSemanticCorpusBuildOptions {
  readonly scope?: SemanticIndexingScope;
  readonly worktreeId?: string;
  readonly ignoreRulesHash?: string;
  readonly cache?: SemanticEmbeddingCachePolicy;
}

export interface ProjectSemanticCorpusBuildResult {
  readonly request: IndexSemanticCorpusRequest | null;
  readonly skippedEmptyDocumentCount: number;
}

const decoder = new TextDecoder();

export function buildIndexSemanticCorpusRequestFromBoundary(
  boundary: SemanticIndexBoundaryResult,
  options: ProjectSemanticCorpusBuildOptions = {},
): ProjectSemanticCorpusBuildResult {
  let skippedEmptyDocumentCount = 0;
  const documents: SemanticCorpusDocument[] = [];
  for (const doc of boundary.documents) {
    const text = decoder.decode(doc.bytes);
    if (text.trim().length === 0) {
      skippedEmptyDocumentCount += 1;
      continue;
    }
    const path = doc.identity.canonicalProjectRelativePath;
    documents.push({
      id: path,
      text,
      metadata: {
        path,
        fsRootIdentityHash: boundary.fsRootIdentityHash,
        worktreeState: doc.worktreeState,
        ...(boundary.headOid !== null ? { headOid: boundary.headOid } : {}),
      },
    });
  }
  if (documents.length === 0) return { request: null, skippedEmptyDocumentCount };
  return {
    request: {
      correlationId: boundary.correlationId,
      projectId: boundary.projectId,
      documents,
      ...(options.scope !== undefined ? { scope: options.scope } : {}),
      ...(options.cache !== undefined ? { cache: options.cache } : {}),
      ...(boundary.headOid !== null &&
      options.worktreeId !== undefined &&
      options.ignoreRulesHash !== undefined
        ? {
            indexContext: {
              worktreeId: options.worktreeId,
              headOid: boundary.headOid,
              ignoreRulesHash: options.ignoreRulesHash,
            },
          }
        : {}),
    },
    skippedEmptyDocumentCount,
  };
}
