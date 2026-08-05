import { SessionError } from './errors.js';
import {
  STAGE_MAX_CHUNK_BYTES,
  STAGE_MAX_TOTAL_BYTES,
  type StageContentInput,
  type StageContentResult,
} from './stagingContracts.js';
import {
  assertUtf8Text,
  bytesOfChunks,
  sha256Hex,
  type StagingEntry,
} from './stagingInternals.js';

export interface StagingStageContext {
  entries: Map<string, StagingEntry>;
  maxChunkBytes: number;
  maxEntriesPerSession: number;
  maxEntryBytes: number;
  reserveAggregate(bytes: number, fromState: string): void;
}

export function stageContent(
context: StagingStageContext,
input: StageContentInput,
fromState: string,
): StageContentResult {
const {
  entries,
  maxChunkBytes,
  maxEntriesPerSession,
  maxEntryBytes,
  reserveAggregate,
} = context;
  if (input.chunkBytes.byteLength > maxChunkBytes) {
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: fromState,
      attempted: 'stageContent',
      detail: `chunk exceeds configured maxChunkBytes (${maxChunkBytes}; default STAGE_MAX_CHUNK_BYTES=${STAGE_MAX_CHUNK_BYTES})`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'chunkSize',
      },
    });
  }
  let entry = entries.get(input.stagingKey);
  const created = entry === undefined;
  if (!entry) {
    if (entries.size >= maxEntriesPerSession) {
      throw new SessionError({
        kind: 'stage_integrity_mismatch',
        from: fromState,
        attempted: 'stageContent',
        detail: `session already holds ${entries.size} staged entries (configured cap ${maxEntriesPerSession})`,
        details: {
          recoveryClass: 'refresh_and_recompute',
          prerequisite: 'entryCount',
        },
      });
    }
    entry = {
      stagingKey: input.stagingKey,
      chunks: [],
      bytesStaged: 0,
      complete: false,
      sha256: null,
      expectedTotalSha256: null,
      expectedTotalByteLength: null,
    };
  }
  if (entry.complete) {
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: fromState,
      attempted: 'stageContent',
      detail: `stagingKey "${input.stagingKey}" is already finalized; reuse requires a new key`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'stagingKey',
      },
    });
  }
  if (input.seq !== entry.chunks.length) {
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: fromState,
      attempted: 'stageContent',
      detail: `chunk seq ${input.seq} does not match expected ${entry.chunks.length}`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'seq',
      },
    });
  }
  const nextBytes = entry.bytesStaged + input.chunkBytes.byteLength;
  if (nextBytes > maxEntryBytes) {
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: fromState,
      attempted: 'stageContent',
      detail: `total staged bytes ${nextBytes} exceeds configured maxEntryBytes (${maxEntryBytes}; default STAGE_MAX_TOTAL_BYTES=${STAGE_MAX_TOTAL_BYTES})`,
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'totalBytes',
      },
    });
  }
  const nextChunk = new Uint8Array(input.chunkBytes);
  const nextChunks = [...entry.chunks, nextChunk];

  if (input.isFinal) {
    if (input.expectedTotalSha256 === undefined || input.expectedTotalByteLength === undefined) {
      throw new SessionError({
        kind: 'stage_integrity_mismatch',
        from: fromState,
        attempted: 'stageContent',
        detail: 'isFinal requires expectedTotalSha256 + expectedTotalByteLength',
        details: {
          recoveryClass: 'refresh_and_recompute',
          prerequisite: 'finalizationMetadata',
        },
      });
    }
    if (nextBytes !== input.expectedTotalByteLength) {
      throw new SessionError({
        kind: 'stage_integrity_mismatch',
        from: fromState,
        attempted: 'stageContent',
        detail: `finalized bytes ${nextBytes} do not match expectedTotalByteLength ${input.expectedTotalByteLength}`,
        details: {
          recoveryClass: 'refresh_and_recompute',
          prerequisite: 'expectedByteLength',
        },
      });
    }
    const finalizedBytes = bytesOfChunks(nextChunks, nextBytes);
    assertUtf8Text(finalizedBytes, fromState);
    const actualSha = sha256Hex(finalizedBytes);
    if (actualSha !== input.expectedTotalSha256) {
      throw new SessionError({
        kind: 'stage_integrity_mismatch',
        from: fromState,
        attempted: 'stageContent',
        detail: `finalized sha256 ${actualSha} does not match expectedTotalSha256 ${input.expectedTotalSha256}`,
        details: {
          recoveryClass: 'refresh_and_recompute',
          prerequisite: 'expectedSha256',
        },
      });
    }
    reserveAggregate(input.chunkBytes.byteLength, fromState);
    entry.chunks = nextChunks;
    entry.bytesStaged = nextBytes;
    entry.complete = true;
    entry.sha256 = actualSha;
    entry.expectedTotalSha256 = input.expectedTotalSha256;
    entry.expectedTotalByteLength = input.expectedTotalByteLength;
  } else {
    reserveAggregate(input.chunkBytes.byteLength, fromState);
    entry.chunks = nextChunks;
    entry.bytesStaged = nextBytes;
  }
  if (created) {
    entries.set(input.stagingKey, entry);
  }

  return {
    stagingKey: entry.stagingKey,
    chunks: entry.chunks.length,
    bytesStaged: entry.bytesStaged,
    complete: entry.complete,
    sha256: entry.sha256,
  };
}
