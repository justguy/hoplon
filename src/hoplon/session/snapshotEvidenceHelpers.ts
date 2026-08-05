/**
 * session/snapshotEvidenceHelpers.ts — internal helpers for the t-081
 * snapshot-evidence composer. Split from `snapshotEvidence.ts` so the
 * composer file stays under the architecture size limit.
 *
 * This module is intentionally not re-exported from the session barrel —
 * callers use `composeSnapshotEvidence` from `snapshotEvidence.ts`. These
 * helpers exist to keep the assertions, live-tree reader, and file-entry
 * renderer in one place that both the composer and the test surface can
 * reuse directly if needed.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import type { WritableManifest } from '../contracts/manifest.js';
import { SemanticError, ValidationError } from '../contracts/errors.js';
import { renderUnifiedDiff } from './unifiedDiff.js';
import type {
  ComposeSnapshotEvidenceInput,
  SnapshotEvidenceDiffFileEntry,
} from './snapshotEvidenceTypes.js';

export type NarrowSnapshotRecord = Pick<
  SnapshotRecord,
  | 'id'
  | 'engineId'
  | 'projectId'
  | 'runId'
  | 'correlationId'
  | 'manifestSchemaVersion'
  | 'status'
  | 'createdAt'
  | 'ttlExpires'
  | 'gitRef'
  | 'manifest'
>;

export function assertSessionAnchor(
  input: ComposeSnapshotEvidenceInput,
  snapshotRefId: string,
  field: string,
): void {
  if (snapshotRefId !== input.sessionSnapshotRefId) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: {
          field,
          sessionSnapshotRefId: input.sessionSnapshotRefId,
          requested: snapshotRefId,
        },
      },
      `snapshotEvidence: ${field} ('${snapshotRefId}') must anchor on the session's own snapshotRefId ('${input.sessionSnapshotRefId}')`,
    );
  }
}

export async function loadCommittedRecord(
  input: ComposeSnapshotEvidenceInput,
  snapshotRefId: string,
  field: string,
): Promise<NarrowSnapshotRecord> {
  const record = await input.snapshotStore.get(snapshotRefId);
  if (record === null) {
    throw new SemanticError(
      {
        kind: 'snapshot_missing',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { field, snapshotRefId },
      },
      `snapshotEvidence: snapshot '${snapshotRefId}' not found in store`,
    );
  }
  if (record.projectId !== input.projectId) {
    throw new SemanticError(
      {
        kind: 'project_id_mismatch',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: {
          field,
          snapshotProjectId: record.projectId,
          sessionProjectId: input.projectId,
          snapshotRefId,
        },
      },
      `snapshotEvidence: project_id mismatch — snapshot '${snapshotRefId}' belongs to '${record.projectId}', session is scoped to '${input.projectId}'`,
    );
  }
  if (record.runId !== input.runId) {
    throw new SemanticError(
      {
        kind: 'run_id_mismatch',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: {
          field,
          snapshotRunId: record.runId,
          sessionRunId: input.runId,
          snapshotRefId,
        },
      },
      `snapshotEvidence: run_id mismatch — snapshot '${snapshotRefId}' belongs to run '${record.runId}', session is scoped to run '${input.runId}'`,
    );
  }
  if (record.status !== 'committed') {
    throw new SemanticError(
      {
        kind: 'snapshot_not_committed',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { field, snapshotRefId, status: record.status },
      },
      `snapshotEvidence: snapshot '${snapshotRefId}' has status '${record.status}' — only committed snapshots carry evidence`,
    );
  }
  if (record.gitRef === null) {
    throw new SemanticError(
      {
        kind: 'snapshot_not_committed',
        engineId: input.engineId,
        correlationId: input.correlationId,
        cause: { field, snapshotRefId, reason: 'missing_gitRef' },
      },
      `snapshotEvidence: snapshot '${snapshotRefId}' is marked committed but has no gitRef`,
    );
  }
  return record;
}

export function manifestFilePaths(manifest: WritableManifest): readonly string[] {
  const paths = manifest.entries.map((e) => e.path);
  return [...new Set(paths)].sort();
}

export function validateRequestedFiles(
  requested: readonly string[],
  ownedFiles: readonly string[],
  input: ComposeSnapshotEvidenceInput,
): readonly string[] {
  const ownedSet = new Set(ownedFiles);
  const normalized: string[] = [];
  for (const filepath of requested) {
    if (!ownedSet.has(filepath)) {
      throw new ValidationError(
        {
          kind: 'invalid_scope',
          engineId: input.engineId,
          correlationId: input.correlationId,
          cause: { filepath, ownedCount: ownedFiles.length },
        },
        `snapshotEvidence: filepath '${filepath}' is not owned by the snapshot's manifest; diff evidence is limited to manifest-owned files`,
      );
    }
    normalized.push(filepath);
  }
  return [...new Set(normalized)].sort();
}

export async function readLiveBytes(
  fs: HoplonFsAdapter,
  filepath: string,
): Promise<Uint8Array | null> {
  try {
    const stat = await fs.stat(filepath);
    if (!stat.exists) return null;
  } catch {
    return null;
  }
  try {
    return await fs.read(filepath);
  } catch {
    // Best-effort: if the live read itself fails (e.g. the file disappeared
    // between stat and read), treat as absent so the diff renders a
    // deletion rather than throwing.
    return null;
  }
}

export function renderFileEntry(
  filepath: string,
  before: Uint8Array | null,
  after: Uint8Array | null,
  contextLines: number,
): SnapshotEvidenceDiffFileEntry {
  const beforeText = before === null ? '' : decodeUtf8(before);
  const afterText = after === null ? '' : decodeUtf8(after);
  let status: SnapshotEvidenceDiffFileEntry['status'];
  if (before === null && after !== null) status = 'added';
  else if (before !== null && after === null) status = 'removed';
  else if (before !== null && after !== null && beforeText !== afterText) status = 'modified';
  else status = 'unchanged';
  const unifiedDiff =
    status === 'unchanged'
      ? ''
      : renderUnifiedDiff(beforeText, afterText, {
          aLabel: filepath,
          bLabel: filepath,
          contextLines,
          includeHeader: true,
        });
  return {
    filepath,
    status,
    unifiedDiff,
    beforeByteLength: before === null ? null : before.byteLength,
    afterByteLength: after === null ? null : after.byteLength,
  };
}

function decodeUtf8(bytes: Uint8Array): string {
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes);
}
