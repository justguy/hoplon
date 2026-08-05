import type { EmbeddingCacheRecord } from '../adapters/embeddingCache.js';
import type {
  SemanticCorpusDocument,
  SemanticDegradationReason,
  SemanticEmbeddingCachePolicy,
  SemanticIndexContext,
  SemanticSearchStatus,
  SemanticTombstoneKind,
  SemanticTombstoneRequest,
} from '../contracts/semanticSearch.js';

export interface SemanticCacheDecision {
  readonly key: string | null;
  readonly canWritePersistentMiss: boolean;
  readonly degradationReason: SemanticDegradationReason | null;
}

export interface SemanticFreshnessDecision {
  readonly status: SemanticSearchStatus | null;
  readonly reason: SemanticDegradationReason | null;
}

export function resolveSemanticFreshness(
  current: SemanticIndexContext | undefined,
  indexed: SemanticIndexContext | undefined,
  allowStale: boolean | undefined,
): SemanticFreshnessDecision {
  if (current === undefined || indexed === undefined) {
    return { status: null, reason: null };
  }
  if (
    current.worktreeId === indexed.worktreeId &&
    current.headOid === indexed.headOid &&
    current.ignoreRulesHash === indexed.ignoreRulesHash
  ) {
    return { status: null, reason: null };
  }
  return {
    status: allowStale === true ? 'DEGRADED' : 'UNAVAILABLE',
    reason:
      current.worktreeId !== indexed.worktreeId ||
      current.ignoreRulesHash !== indexed.ignoreRulesHash
        ? 'index_context_mismatch'
        : 'index_stale',
  };
}

export function resolveSemanticCacheDecision(
  projectId: string,
  document: SemanticCorpusDocument,
  policy: SemanticEmbeddingCachePolicy | undefined,
  dryRun: boolean | undefined,
): SemanticCacheDecision {
  if (
    policy?.persistence === 'disabled' ||
    document.documentTextHash === undefined ||
    document.embeddingProfileHash === undefined
  ) {
    return { key: null, canWritePersistentMiss: false, degradationReason: null };
  }

  const mode = policy?.mode ?? 'project_scoped';
  const keyParts = [
    `project:${projectId}`,
    `profile:${document.embeddingProfileHash}`,
    `text:${document.documentTextHash}`,
  ];
  if (mode === 'shared_physical') {
    keyParts.unshift(`tenant:${policy?.tenantNamespace ?? ''}`);
  }
  const key = keyParts.join('|');
  const verified = document.embeddingProfileVerified === true;
  const canWritePersistentMiss =
    policy?.persistence === 'write_through' && dryRun !== true && verified;

  return {
    key,
    canWritePersistentMiss,
    degradationReason:
      policy?.persistence === 'write_through' && !verified
        ? 'embedding_profile_unverified'
        : null,
  };
}

export function createEmbeddingCacheRecord(
  key: string,
  vector: number[],
  document: SemanticCorpusDocument,
): EmbeddingCacheRecord {
  return {
    key,
    vector: [...vector],
    modelId: document.embeddingProfileHash ?? 'unverified',
    contentHash: document.documentTextHash ?? document.id,
    updatedAt: new Date(0).toISOString(),
  };
}

export function collectSemanticTombstones(req: {
  readonly deletedDocumentIds?: readonly string[] | undefined;
  readonly versionDeletedDocumentIds?: readonly string[] | undefined;
  readonly tombstones?: readonly SemanticTombstoneRequest[] | undefined;
}): SemanticTombstoneRequest[] {
  const tombstones = new Map<string, SemanticTombstoneKind>();
  for (const id of req.deletedDocumentIds ?? []) tombstones.set(id, 'deleted');
  for (const id of req.versionDeletedDocumentIds ?? []) {
    tombstones.set(id, 'deleted');
  }
  for (const tombstone of req.tombstones ?? []) {
    tombstones.set(tombstone.id, tombstone.kind);
  }
  return [...tombstones].map(([id, kind]) => ({ id, kind }));
}

export function uniqueReasons(
  reasons: readonly (SemanticDegradationReason | string | null | undefined)[],
): SemanticDegradationReason[] {
  const allowed = new Set<SemanticDegradationReason>([
    'provider_not_bound',
    'no_indexed_corpus',
    'embedding_unavailable',
    'embedding_cache_unavailable',
    'embedding_profile_unverified',
    'vector_index_unavailable',
    'lexical_only_profile',
    'index_context_mismatch',
    'ignore_rules_changed_full_reconcile_required',
    'index_stale',
    'overlay_reaped',
    'overlay_reaped_inactive_ttl',
    'overlay_never_created',
    'overlay_unavailable_process_local_store',
    'overlay_store_reset',
    'overlay_refresh_failed',
    'overlay_refresh_aborted',
    'overlay_refresh_stale_generation',
    'stale_index',
    'unauthorized_rows_filtered',
    'native_extension_failure',
    'empty_query_vector',
    'unindexable_document',
  ]);
  const filtered = reasons.filter(
    (reason): reason is SemanticDegradationReason =>
      typeof reason === 'string' && allowed.has(reason as SemanticDegradationReason),
  );
  return [...new Set(filtered)];
}
