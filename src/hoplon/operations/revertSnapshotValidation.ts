import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import type { WritableManifest } from '../contracts/manifest.js';
import type { RevertRequest } from '../contracts/requests.js';
import { SemanticError } from '../contracts/errors.js';

export interface ResolvedRevertSnapshot {
  record: SnapshotRecord;
  manifest: WritableManifest;
  gitRef: string;
}

export function validateRevertSnapshot(
  record: SnapshotRecord | null,
  request: RevertRequest,
  engineId: string,
): ResolvedRevertSnapshot {
  const correlationId = request.correlationId;
  if (record === null) {
    throw new SemanticError(
      {
        kind: 'snapshot_missing',
        engineId,
        correlationId,
        cause: { snapshotRefId: request.snapshotRefId },
      },
      `revertUncontracted: snapshot not found: ${request.snapshotRefId}`,
    );
  }
  if (record.projectId !== request.projectId) {
    throw new SemanticError(
      {
        kind: 'project_id_mismatch',
        engineId,
        correlationId,
        cause: { expected: request.projectId, actual: record.projectId },
      },
      `revertUncontracted: AS-2 project_id_mismatch: snapshot belongs to '${record.projectId}', request uses '${request.projectId}'`,
    );
  }
  if (record.runId !== request.runId) {
    throw new SemanticError(
      {
        kind: 'run_id_mismatch',
        engineId,
        correlationId,
        cause: { expected: request.runId, actual: record.runId },
      },
      `revertUncontracted: AS-2 run_id_mismatch: snapshot belongs to run '${record.runId}', request uses '${request.runId}'`,
    );
  }
  if (record.status !== 'committed') {
    throw new SemanticError(
      {
        kind: 'snapshot_not_committed',
        engineId,
        correlationId,
        cause: { actualStatus: record.status },
      },
      `revertUncontracted: AS-2 snapshot_not_committed: status is '${record.status}', expected 'committed'`,
    );
  }
  if (record.manifest === null) {
    throw new SemanticError(
      {
        kind: 'snapshot_missing',
        engineId,
        correlationId,
        cause: {
          snapshotRefId: request.snapshotRefId,
          reason: 'manifest_null',
        },
      },
      'revertUncontracted: snapshot manifest is null (hash_only mode not supported for revert)',
    );
  }
  if (record.gitRef === null) {
    throw new SemanticError(
      {
        kind: 'snapshot_not_committed',
        engineId,
        correlationId,
        cause: { actualStatus: record.status, reason: 'gitRef_null' },
      },
      'revertUncontracted: snapshot gitRef is null on committed record',
    );
  }
  return { record, manifest: record.manifest, gitRef: record.gitRef };
}
