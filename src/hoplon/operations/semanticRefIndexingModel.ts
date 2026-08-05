import type { VersioningSourceRef } from '../adapters/versioning.js';
import type {
  IndexSemanticCorpusResult,
  SemanticEmbeddingCachePolicy,
} from '../contracts/semanticSearch.js';
import type { SemanticSearchBranchScope } from '../contracts/semanticSearchRecovery.js';
import type { SemanticIndexBoundaryDeps } from './semanticIndexBoundary.js';
import type { SemanticSearchDeps } from './semanticSearchShared.js';

export interface SemanticRefIndexingDeps extends SemanticIndexBoundaryDeps {
  readonly semantic: SemanticSearchDeps;
}

export interface SemanticRefIndexingRequest {
  readonly projectId: string;
  readonly runId?: string;
  readonly correlationId: string;
  readonly fsRootIdentityHash: string;
  readonly branchScope: SemanticSearchBranchScope;
  readonly corpusSchemaVersion: string;
  readonly embeddingProfileHash?: string;
  readonly modelProfileHash?: string;
  readonly embeddingProfileVerified?: boolean;
  readonly cache?: SemanticEmbeddingCachePolicy;
  readonly force?: boolean;
}

export interface SemanticRefIndexingResult {
  readonly status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'EMPTY';
  readonly projectId: string;
  readonly correlationId: string;
  readonly resolvedBranchCount: number;
  readonly indexedCommitCount: number;
  readonly indexedDocumentCount: number;
  readonly aliasOnlyCommitCount: number;
  readonly aliasRefreshedDocumentCount: number;
  readonly excludedCount: number;
  readonly degradationReasons: readonly string[];
  readonly indexResult?: IndexSemanticCorpusResult;
}

export interface ResolvedSemanticSourceRef {
  readonly kind: VersioningSourceRef['kind'];
  readonly name: string;
  readonly fullRef: string;
  readonly oid: string;
  readonly remote?: string;
  readonly isCurrent: boolean;
  readonly isDefault: boolean;
}

export const SEMANTIC_REF_OBSERVED_AT_ISO = '1970-01-01T00:00:00.000Z';
