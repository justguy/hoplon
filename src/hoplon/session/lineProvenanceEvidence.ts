import { ValidationError } from '../contracts/errors.js';
import {
  assertSessionAnchor,
  loadCommittedRecord,
  manifestFilePaths,
  validateRequestedFiles,
} from './snapshotEvidenceHelpers.js';
import type {
  ComposeSnapshotEvidenceInput,
  SnapshotEvidenceLineProvenanceRequest,
  SnapshotEvidenceLineProvenanceResult,
} from './snapshotEvidenceTypes.js';

export async function composeLineProvenance(
  input: ComposeSnapshotEvidenceInput,
  request: SnapshotEvidenceLineProvenanceRequest,
): Promise<SnapshotEvidenceLineProvenanceResult> {
  assertSessionAnchor(input, request.snapshotRefId, 'snapshotRefId');
  const record = await loadCommittedRecord(input, request.snapshotRefId, 'snapshotRefId');
  if (record.manifest === null) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { snapshotRefId: record.id, reason: 'manifest_hash_only' },
      },
      `snapshotEvidence: snapshot '${record.id}' was stored in hash-only mode; line provenance requires an inline manifest`,
    );
  }
  validateRequestedFiles([request.file], manifestFilePaths(record.manifest), input);
  const lineRange = lineRangeForTarget(input, request);
  const provenance = await input.versioning.readLineProvenance({
    dir: input.gitRepoDir,
    ref: record.gitRef as string,
    filepath: request.file,
    lineRange,
  });
  return {
    kind: 'line_provenance',
    snapshotRefId: record.id,
    snapshotGitCommitSha: record.gitRef as string,
    file: request.file,
    target: request.target,
    lineRange: provenance.lineRange,
    commit: {
      commitId: provenance.commitId,
      parentOids: provenance.parentOids,
      authorName: provenance.authorName,
      authorTimestamp: provenance.authorTimestamp,
      committerTimestamp: provenance.committerTimestamp,
      messageFirstLine: provenance.messageFirstLine,
    },
    provenanceKind: provenance.provenanceKind,
    generatedAt: new Date(input.now()).toISOString(),
  };
}

function lineRangeForTarget(
  input: ComposeSnapshotEvidenceInput,
  request: SnapshotEvidenceLineProvenanceRequest,
): { readonly startLine: number; readonly endLine: number } {
  const lineRange =
    request.target.kind === 'line_range'
      ? request.target.lineRange
      : request.target.syntaxNode.lineRange;
  if (
    !Number.isInteger(lineRange.startLine) ||
    !Number.isInteger(lineRange.endLine) ||
    lineRange.startLine < 1 ||
    lineRange.endLine < lineRange.startLine
  ) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { target: request.target },
      },
      'snapshotEvidence: line provenance target requires a 1-based line range with endLine >= startLine',
    );
  }
  return lineRange;
}
