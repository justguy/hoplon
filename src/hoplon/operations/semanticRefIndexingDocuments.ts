import { createHash } from 'node:crypto';

import type {
  IndexSemanticCorpusRequest,
  SemanticBranchAlias,
  SemanticCorpusDocument,
  SemanticSourceCommitSnapshot,
} from '../contracts/semanticSearch.js';
import {
  canonicalSemanticIndexCandidatePath,
  isHardSemanticSidecarPath,
} from './semanticIndexBoundary.js';
import { abortError } from './semanticSearchShared.js';
import type {
  ResolvedSemanticSourceRef,
  SemanticRefIndexingDeps,
  SemanticRefIndexingRequest,
} from './semanticRefIndexingModel.js';
import { SEMANTIC_REF_OBSERVED_AT_ISO } from './semanticRefIndexingModel.js';

const decoder = new TextDecoder();

export async function buildDocumentsForCommit(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
  commitOid: string,
  refs: readonly ResolvedSemanticSourceRef[],
  signal?: AbortSignal,
): Promise<{ documents: SemanticCorpusDocument[]; excludedCount: number }> {
  const files = await deps.versioning.listFilesAtRef(deps.root, commitOid);
  const sourceSnapshot = snapshotFor(req, commitOid);
  const aliases = refs.map((ref) =>
    aliasFor(req, ref, sourceSnapshot.sourceSnapshotId),
  );
  const documents: SemanticCorpusDocument[] = [];
  let excludedCount = 0;
  for (const file of files) {
    if (signal?.aborted) throw abortError(signal);
    const path = canonicalSemanticIndexCandidatePath(deps, req, file.filepath);
    if (isHardSemanticSidecarPath(path)) {
      excludedCount += 1;
      continue;
    }
    const blob = await deps.versioning.readBlobAtRef(deps.root, commitOid, path);
    const text = decoder.decode(blob.bytes);
    if (text.trim().length === 0) continue;
    documents.push(documentFor(req, sourceSnapshot, refs, aliases, blob, path));
  }
  return { documents, excludedCount };
}

export function mergeDocumentAliases(
  docs: readonly SemanticCorpusDocument[],
  aliases: readonly SemanticBranchAlias[],
): SemanticCorpusDocument[] {
  return docs.map((doc) => ({
    ...doc,
    branchAliases: mergeAliases(doc.branchAliases ?? [], aliases),
  }));
}

export function markStaleAliases(
  docs: readonly SemanticCorpusDocument[],
  refs: readonly ResolvedSemanticSourceRef[],
): SemanticCorpusDocument[] {
  const touched = new Map(refs.map((ref) => [`${ref.kind}:${ref.name}`, ref.oid]));
  return docs.flatMap((doc) => {
    const aliases = doc.branchAliases ?? [];
    let changed = false;
    const nextAliases = aliases.map((alias) => {
      const currentOid = touched.get(`${alias.branchKind}:${alias.branchName}`);
      if (
        currentOid === undefined ||
        currentOid === alias.commitOid ||
        alias.staleState === 'stale'
      ) {
        return alias;
      }
      changed = true;
      return { ...alias, staleState: 'stale' as const };
    });
    return changed ? [{ ...doc, branchAliases: nextAliases }] : [];
  });
}

export function corpusRequest(
  req: SemanticRefIndexingRequest,
  documents: readonly SemanticCorpusDocument[],
): IndexSemanticCorpusRequest | null {
  if (documents.length === 0) return null;
  return {
    correlationId: req.correlationId,
    projectId: req.projectId,
    documents: [...documents],
    ...(req.cache === undefined ? {} : { cache: req.cache }),
  };
}

export function aliasFor(
  req: SemanticRefIndexingRequest,
  ref: ResolvedSemanticSourceRef,
  sourceSnapshotId: string,
): SemanticBranchAlias {
  return {
    projectId: req.projectId,
    sourceSnapshotId,
    branchName: ref.name,
    branchKind: ref.kind,
    commitOid: ref.oid,
    observedAtIso: SEMANTIC_REF_OBSERVED_AT_ISO,
    isDefault: ref.isDefault,
    isCurrent: ref.isCurrent,
    staleState: 'fresh',
    ...(ref.remote === undefined ? {} : { remote: ref.remote }),
  };
}

export function snapshotId(req: SemanticRefIndexingRequest, commitOid: string): string {
  return `source:${req.projectId}:${commitOid}:${req.corpusSchemaVersion}:${
    req.embeddingProfileHash ?? req.modelProfileHash
  }`;
}

function documentFor(
  req: SemanticRefIndexingRequest,
  sourceSnapshot: SemanticSourceCommitSnapshot,
  refs: readonly ResolvedSemanticSourceRef[],
  aliases: readonly SemanticBranchAlias[],
  blob: { readonly oid: string; readonly bytes: Uint8Array },
  path: string,
): SemanticCorpusDocument {
  const contentHash = sha256Bytes(blob.bytes);
  const id = `source/${sourceSnapshot.commitOid}/${path}`;
  const embeddingProfileHash = req.embeddingProfileHash ?? req.modelProfileHash;
  return {
    id,
    text: decoder.decode(blob.bytes),
    documentTextHash: contentHash,
    ...(req.embeddingProfileHash === undefined
      ? {}
      : { embeddingProfileHash: req.embeddingProfileHash }),
    ...(req.embeddingProfileVerified === undefined
      ? {}
      : { embeddingProfileVerified: req.embeddingProfileVerified }),
    metadata: {
      path,
      commitOid: sourceSnapshot.commitOid,
      blobOid: blob.oid,
      fsRootIdentityHash: req.fsRootIdentityHash,
    },
    sourceSnapshot,
    branchAliases: [...aliases],
    chunkIdentity: {
      projectId: req.projectId,
      sourceSnapshotId: sourceSnapshot.sourceSnapshotId,
      chunkId: id,
      canonicalPath: path,
      contentHash,
      chunkHash: contentHash,
      chunkIndex: 0,
      sourceProvenance: {
        commitOid: sourceSnapshot.commitOid,
        branchNames: refs.map((ref) => ref.name),
      },
      embeddingCacheKey: [
        `project:${req.projectId}`,
        `profile:${embeddingProfileHash ?? 'unprofiled'}`,
        `text:${contentHash}`,
      ].join('|'),
    },
  };
}

function snapshotFor(
  req: SemanticRefIndexingRequest,
  commitOid: string,
): SemanticSourceCommitSnapshot {
  return {
    sourceSnapshotId: snapshotId(req, commitOid),
    projectId: req.projectId,
    commitOid,
    corpusSchemaVersion: req.corpusSchemaVersion,
    ...(req.embeddingProfileHash === undefined
      ? {}
      : { embeddingProfileHash: req.embeddingProfileHash }),
    ...(req.modelProfileHash === undefined
      ? {}
      : { modelProfileHash: req.modelProfileHash }),
  };
}

function mergeAliases(
  existing: readonly SemanticBranchAlias[],
  additions: readonly SemanticBranchAlias[],
): SemanticBranchAlias[] {
  const byKey = new Map<string, SemanticBranchAlias>();
  for (const alias of existing) byKey.set(aliasKey(alias), alias);
  for (const alias of additions) byKey.set(aliasKey(alias), alias);
  return [...byKey.values()].sort((a, b) => aliasKey(a).localeCompare(aliasKey(b)));
}

function aliasKey(alias: SemanticBranchAlias): string {
  return `${alias.branchKind}:${alias.branchName}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return `sha256:${createHash('sha256').update(bytes).digest('hex')}`;
}
