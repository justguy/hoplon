/**
 * session/snapshotEvidence.ts — t-081 narrow snapshot-scoped Git evidence
 * composer.
 *
 * This module answers exactly one question: "given a committed Hoplon
 * snapshotRefId, what is its diff or its provenance — scoped to the files
 * the manifest actually owns?" It is explicitly **not** a generic git
 * porcelain:
 *
 *   - It never exposes arbitrary commit SHAs. Every result carries a
 *     `snapshotRefId` (or a pair of them) derived from committed
 *     `SnapshotRecord`s via the injected `SnapshotStore`. The raw git
 *     commit SHA is surfaced only as the `snapshotGitCommitSha` field,
 *     mirrored directly from the committed record — never resolved from
 *     an untrusted input ref.
 *   - It never walks history, enumerates branches, or lists tags.
 *     Metadata comes from two sources: the committed `SnapshotRecord`
 *     (authoritative Hoplon-side row) and the narrow
 *     `versioning.readCommitInfo` adapter primitive.
 *   - It never invokes `versioning.push` / `versioning.fetch`. Remote
 *     transport stays on the shipped `t-033` path; this module does not
 *     touch it.
 *   - It never renders a raw `git diff` porcelain. The diff kind re-uses
 *     the existing deterministic `renderUnifiedDiff` helper over bytes
 *     read via the bounded `versioning.diffSnapshotFiles` adapter
 *     primitive.
 *
 * v1 operations:
 *
 *   - `kind: 'diff'` — bounded unified-diff evidence scoped to files the
 *     snapshot manifest owns (optionally narrowed further by the caller).
 *     The `to` side is either another snapshotRefId from the same project
 *     + run (cross-snapshot compare) or the literal string `'live'`
 *     (snapshot-vs-live-tree, read through the injected fs adapter).
 *   - `kind: 'provenance'` — content-free metadata: createdAt,
 *     projectId, runId, correlationId, engineId, manifestSchemaVersion,
 *     status, ttlExpires, plus the narrow commit-level metadata
 *     (parent oids, tree oid, committer/author timestamps, first line of
 *     the commit message).
 *
 * Every result carries the snapshotRefId(s) it was derived from so audit
 * evidence stays tied to authoritative artifacts.
 */

import { ValidationError } from '../contracts/errors.js';
import { SessionError } from './errors.js';
import type {
  ComposeSnapshotEvidenceInput,
  SnapshotEvidenceDiffFileEntry,
  SnapshotEvidenceDiffRequest,
  SnapshotEvidenceDiffResult,
  SnapshotEvidenceProvenanceRequest,
  SnapshotEvidenceProvenanceResult,
  SnapshotEvidenceResult,
} from './snapshotEvidenceTypes.js';
import {
  assertSessionAnchor,
  loadCommittedRecord,
  manifestFilePaths,
  readLiveBytes,
  renderFileEntry,
  validateRequestedFiles,
  type NarrowSnapshotRecord,
} from './snapshotEvidenceHelpers.js';
import { composeLineProvenance } from './lineProvenanceEvidence.js';

export type {
  ComposeSnapshotEvidenceInput,
  SnapshotEvidenceDiffFileEntry,
  SnapshotEvidenceDiffRequest,
  SnapshotEvidenceDiffResult,
  SnapshotEvidenceKind,
  SnapshotEvidenceLineProvenanceRequest,
  SnapshotEvidenceLineProvenanceResult,
  SnapshotEvidenceProvenanceRequest,
  SnapshotEvidenceProvenanceResult,
  SnapshotEvidenceRequest,
  SnapshotEvidenceResult,
} from './snapshotEvidenceTypes.js';

export async function composeSnapshotEvidence(
  input: ComposeSnapshotEvidenceInput,
): Promise<SnapshotEvidenceResult> {
  const { request } = input;
  if (request.kind === 'provenance') {
    return composeProvenance(input, request);
  }
  if (request.kind === 'diff') {
    return composeDiff(input, request);
  }
  if (request.kind === 'line_provenance') {
    return composeLineProvenance(input, request);
  }
  // Exhaustiveness guard — any unknown kind (e.g. smuggled through a loose
  // transport boundary) is refused with a typed error rather than silently
  // returning a partial result.
  const exhaustiveCheck: never = request;
  throw new ValidationError(
    {
      kind: 'invalid_scope',
      engineId: input.engineId,
      correlationId: input.correlationId,
      cause: { request: exhaustiveCheck },
    },
    'snapshotEvidence: unknown request kind',
  );
}

async function composeProvenance(
  input: ComposeSnapshotEvidenceInput,
  request: SnapshotEvidenceProvenanceRequest,
): Promise<SnapshotEvidenceProvenanceResult> {
  assertSessionAnchor(input, request.snapshotRefId, 'snapshotRefId');
  const record = await loadCommittedRecord(
    input,
    request.snapshotRefId,
    'snapshotRefId',
  );
  const commit = await input.versioning.readCommitInfo({
    dir: input.gitRepoDir,
    ref: record.gitRef as string,
  });
  const manifestEntryCount =
    record.manifest !== null ? record.manifest.entries.length : 0;
  return {
    kind: 'provenance',
    snapshotRefId: record.id,
    snapshotGitCommitSha: record.gitRef as string,
    engineId: record.engineId,
    projectId: record.projectId,
    runId: record.runId,
    correlationId: record.correlationId,
    manifestSchemaVersion: record.manifestSchemaVersion,
    status: record.status,
    createdAt: record.createdAt,
    ttlExpires: record.ttlExpires,
    manifestEntryCount,
    commit: {
      treeOid: commit.treeOid,
      parentOids: commit.parentOids,
      committerTimestamp: commit.committerTimestamp,
      authorTimestamp: commit.authorTimestamp,
      messageFirstLine: commit.messageFirstLine,
    },
    generatedAt: new Date(input.now()).toISOString(),
  };
}

async function composeDiff(
  input: ComposeSnapshotEvidenceInput,
  request: SnapshotEvidenceDiffRequest,
): Promise<SnapshotEvidenceDiffResult> {
  assertSessionAnchor(input, request.fromSnapshotRefId, 'fromSnapshotRefId');
  const fromRecord = await loadCommittedRecord(
    input,
    request.fromSnapshotRefId,
    'fromSnapshotRefId',
  );
  const manifest = fromRecord.manifest;
  if (manifest === null) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { snapshotRefId: fromRecord.id, reason: 'manifest_hash_only' },
      },
      `snapshotEvidence: snapshot '${fromRecord.id}' was stored in hash-only mode; diff evidence requires an inline manifest`,
    );
  }
  const ownedFiles = manifestFilePaths(manifest);
  const contextLines = request.contextLines ?? 3;

  const requestedFiles =
    request.files && request.files.length > 0
      ? validateRequestedFiles(request.files, ownedFiles, input)
      : ownedFiles;

  if (request.to === 'live') {
    return composeDiffAgainstLive(
      input,
      fromRecord,
      requestedFiles,
      contextLines,
    );
  }

  if (request.to === request.fromSnapshotRefId) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { snapshotRefId: request.to },
      },
      'snapshotEvidence: cross-snapshot diff requires two distinct snapshotRefIds',
    );
  }
  const toRecord = await loadCommittedRecord(
    input,
    request.to,
    'to.snapshotRefId',
  );
  const bytes = await input.versioning.diffSnapshotFiles({
    dir: input.gitRepoDir,
    fromRef: fromRecord.gitRef as string,
    toRef: toRecord.gitRef as string,
    filepaths: requestedFiles,
  });
  const fileEntries = bytes.map((entry) =>
    renderFileEntry(entry.filepath, entry.beforeBytes, entry.afterBytes, contextLines),
  );
  return {
    kind: 'diff',
    fromSnapshotRefId: fromRecord.id,
    toSnapshotRefId: toRecord.id,
    files: fileEntries,
    generatedAt: new Date(input.now()).toISOString(),
  };
}

async function composeDiffAgainstLive(
  input: ComposeSnapshotEvidenceInput,
  fromRecord: NarrowSnapshotRecord,
  requestedFiles: readonly string[],
  contextLines: number,
): Promise<SnapshotEvidenceDiffResult> {
  if (input.fs === null) {
    throw new SessionError(
      {
        kind: 'missing_prerequisite',
        from: 'audited_pass',
        attempted: 'getSnapshotEvidence',
        detail: 'diff with to=live requires an fs adapter on the session',
        details: {
          recoveryClass: 'check_prerequisites',
          prerequisite: 'fs',
        },
      },
      "snapshotEvidence: diff with to='live' requires a HoplonFsAdapter to read the current tree",
    );
  }
  const snapshotBytes = await input.versioning.diffSnapshotFiles({
    dir: input.gitRepoDir,
    fromRef: fromRecord.gitRef as string,
    toRef: null,
    filepaths: requestedFiles,
  });
  const fileEntries: SnapshotEvidenceDiffFileEntry[] = [];
  for (const entry of snapshotBytes) {
    const before = entry.beforeBytes;
    const after = await readLiveBytes(input.fs, entry.filepath);
    fileEntries.push(
      renderFileEntry(entry.filepath, before, after, contextLines),
    );
  }
  return {
    kind: 'diff',
    fromSnapshotRefId: fromRecord.id,
    toSnapshotRefId: 'live',
    files: fileEntries,
    generatedAt: new Date(input.now()).toISOString(),
  };
}
