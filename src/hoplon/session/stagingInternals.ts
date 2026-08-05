import { createHash } from 'node:crypto';

import { SessionError } from './errors.js';

export interface StagingEntry {
  stagingKey: string;
  chunks: Uint8Array[];
  bytesStaged: number;
  complete: boolean;
  sha256: string | null;
  expectedTotalSha256: string | null;
  expectedTotalByteLength: number | null;
}

export function bytesOfChunks(
  chunks: readonly Uint8Array[],
  bytesStaged: number,
): Uint8Array {
  const onlyChunk = chunks.length === 1 ? chunks[0] : undefined;
  if (onlyChunk !== undefined) return onlyChunk;
  const out = new Uint8Array(bytesStaged);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

export function bytesOfEntry(entry: StagingEntry): Uint8Array {
  return bytesOfChunks(entry.chunks, entry.bytesStaged);
}

export function sha256Hex(bytes: Uint8Array): string {
  const h = createHash('sha256');
  h.update(bytes);
  return h.digest('hex');
}

export function assertUtf8Text(bytes: Uint8Array, fromState: string): void {
  try {
    new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new SessionError({
      kind: 'stage_integrity_mismatch',
      from: fromState,
      attempted: 'stageContent',
      detail: 'finalized staged body is not valid UTF-8 text',
      details: {
        recoveryClass: 'refresh_and_recompute',
        prerequisite: 'utf8_text',
      },
    });
  }
}

export function validatedLimit(
  name: string,
  configured: number | undefined,
  fallback: number,
): number {
  const value = configured ?? fallback;
  assertPositiveSafeInteger(name, value);
  return value;
}

export function assertPositiveSafeInteger(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw invalidStagingConfiguration(
      `${name} must be a positive safe integer; received ${String(value)}`,
      name,
    );
  }
}

export function invalidStagingConfiguration(
  detail: string,
  prerequisite: string,
): SessionError {
  return new SessionError({
    kind: 'stage_integrity_mismatch',
    from: 'created',
    attempted: 'configureStaging',
    detail,
    details: {
      recoveryClass: 'refresh_and_recompute',
      prerequisite,
    },
  });
}
