import type { SnapshotRecord, SnapshotStore } from '../adapters/snapshotStore.js';
import type { DryRunRequest } from '../contracts/requests.js';
import { AdapterError, SemanticError } from '../contracts/errors.js';

export async function resolveDryRunSnapshot(
  snapshotStore: SnapshotStore,
  request: DryRunRequest,
  engineId: string,
  manifestSchemaVersion: 1,
): Promise<SnapshotRecord> {
  let record: SnapshotRecord | null;
  try {
    record = await snapshotStore.get(request.snapshotRefId);
  } catch (cause) {
    throw new AdapterError(
      {
        kind: 'snapshot_store_read_failed',
        engineId,
        correlationId: request.correlationId,
        cause,
      },
      `dryRun: snapshot store read failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (record === null) {
    throw new SemanticError(
      {
        kind: 'snapshot_missing',
        engineId,
        correlationId: request.correlationId,
        cause: { snapshotRefId: request.snapshotRefId },
      },
      `dryRun: snapshot '${request.snapshotRefId}' not found in store`,
    );
  }
  if (record.projectId !== request.projectId) {
    throw new SemanticError(
      {
        kind: 'project_id_mismatch',
        engineId,
        correlationId: request.correlationId,
        cause: {
          snapshotProjectId: record.projectId,
          requestProjectId: request.projectId,
          snapshotRefId: request.snapshotRefId,
        },
      },
      `dryRun: project_id mismatch — snapshot belongs to '${record.projectId}', request is for '${request.projectId}'`,
    );
  }
  if (record.runId !== request.runId) {
    throw new SemanticError(
      {
        kind: 'run_id_mismatch',
        engineId,
        correlationId: request.correlationId,
        cause: {
          snapshotRunId: record.runId,
          requestRunId: request.runId,
          snapshotRefId: request.snapshotRefId,
        },
      },
      `dryRun: run_id mismatch — snapshot belongs to run '${record.runId}', request is for run '${request.runId}'`,
    );
  }
  if (record.status !== 'committed') {
    throw new SemanticError(
      {
        kind: 'snapshot_not_committed',
        engineId,
        correlationId: request.correlationId,
        cause: {
          snapshotStatus: record.status,
          snapshotRefId: request.snapshotRefId,
        },
      },
      `dryRun: snapshot '${request.snapshotRefId}' has status '${record.status}' — only 'committed' snapshots can be evaluated`,
    );
  }
  if (record.manifestSchemaVersion !== manifestSchemaVersion) {
    throw new SemanticError(
      {
        kind: 'manifest_version_mismatch',
        engineId,
        correlationId: request.correlationId,
        cause: {
          snapshotVersion: record.manifestSchemaVersion,
          engineVersion: manifestSchemaVersion,
          snapshotRefId: request.snapshotRefId,
        },
      },
      `dryRun: manifest schema version mismatch — snapshot has version ${record.manifestSchemaVersion}, engine expects ${manifestSchemaVersion}`,
    );
  }
  return record;
}
