/**
 * operations/createSnapshotIdentity.ts — snapshot identity helpers for D1.
 *
 * hcr-001: snapshot identity covers manifest JSON plus actual file bytes.
 * `readManifestEntryBytesOnce` is the SINGLE read pipeline — each manifest
 * file's bytes are read exactly once through the fs adapter and those same
 * bytes feed content hashing (identity), secret/DLP scanning, and the git
 * commit. This closes the scan-to-commit race: what was scanned is what is
 * committed, byte for byte.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import { AdapterError, SemanticError } from '../contracts/errors.js';
import type { WritableManifest } from '../contracts/manifest.js';
import { hashFileContent } from '../util/hashManifest.js';
import type { ManifestContentHash } from '../util/hashManifest.js';

/** One manifest entry's bytes at snapshot time. `bytes === null` = absent. */
export interface ManifestEntryBytes {
  readonly path: string;
  readonly bytes: Uint8Array | null;
}

/**
 * Read every manifest entry's bytes exactly once through the fs adapter.
 * Returns one element per manifest entry, in manifest order.
 *
 * @throws {AdapterError} kind 'fs_read_failed' — fs.stat or fs.read failed
 *   unexpectedly (a missing file is NOT a failure; it reads as bytes: null).
 */
export async function readManifestEntryBytesOnce(args: {
  readonly fs: HoplonFsAdapter;
  readonly entries: ReadonlyArray<{ readonly path: string }>;
  readonly engineId: string;
  readonly correlationId: string;
}): Promise<ManifestEntryBytes[]> {
  const { fs, entries, engineId, correlationId } = args;
  const reads: ManifestEntryBytes[] = [];
  for (const entry of entries) {
    let statResult: Awaited<ReturnType<typeof fs.stat>>;
    try {
      statResult = await fs.stat(entry.path);
    } catch (cause) {
      throw new AdapterError(
        { kind: 'fs_read_failed', engineId, correlationId, cause },
        `createSnapshot: read pipeline: fs.stat('${entry.path}') failed`,
      );
    }
    if (!statResult.exists) {
      reads.push({ path: entry.path, bytes: null });
      continue;
    }
    let bytes: Uint8Array;
    try {
      bytes = await fs.read(entry.path);
    } catch (cause) {
      throw new AdapterError(
        { kind: 'fs_read_failed', engineId, correlationId, cause },
        `createSnapshot: read pipeline: fs.read('${entry.path}') failed`,
      );
    }
    reads.push({ path: entry.path, bytes });
  }
  return reads;
}

/**
 * Map the single-read pipeline output to per-path content digests for the
 * canonical snapshot-ID producer (`hashManifestWithContent`).
 */
export function contentHashesForReads(
  reads: ReadonlyArray<ManifestEntryBytes>,
): ManifestContentHash[] {
  return reads.map((read) => ({
    path: read.path,
    contentSha256: read.bytes === null ? null : hashFileContent(read.bytes),
  }));
}

interface AssertCommittedSnapshotIdentityArgs {
  readonly existing: Pick<SnapshotRecord, 'projectId' | 'runId'>;
  readonly manifest: Pick<WritableManifest, 'projectId' | 'runId' | 'correlationId'>;
  readonly snapshotRefId: string;
  readonly engineId: string;
}

export function assertCommittedSnapshotIdentity(
  args: AssertCommittedSnapshotIdentityArgs,
): void {
  const { existing, manifest, snapshotRefId, engineId } = args;
  if (existing.projectId !== manifest.projectId) {
    throw new SemanticError(
      {
        kind: 'project_id_mismatch',
        engineId,
        correlationId: manifest.correlationId,
        cause: {
          snapshotProjectId: existing.projectId,
          requestProjectId: manifest.projectId,
          snapshotRefId,
        },
      },
      `createSnapshot: committed duplicate project_id mismatch: snapshot belongs to '${existing.projectId}', request is for '${manifest.projectId}'`,
    );
  }
  if (existing.runId !== manifest.runId) {
    throw new SemanticError(
      {
        kind: 'run_id_mismatch',
        engineId,
        correlationId: manifest.correlationId,
        cause: {
          snapshotRunId: existing.runId,
          requestRunId: manifest.runId,
          snapshotRefId,
        },
      },
      `createSnapshot: committed duplicate run_id mismatch: snapshot belongs to run '${existing.runId}', request is for run '${manifest.runId}'`,
    );
  }
}
