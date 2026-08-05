import type {
  PackedContext,
  PackedSlice,
  PackFailure,
} from '../../contracts/context.js';

export const NDJSON_STREAM_THRESHOLD_BYTES = 1_048_576;

export interface MetadataFrameValue {
  strategyVersion: number;
  grammarVersion: string;
  packerVersion: number;
  generatedAt: string;
  correlationId: string;
  failures: PackFailure[];
}

export type NdjsonFrame =
  | { type: 'metadata'; value: MetadataFrameValue }
  | { type: 'slice'; value: PackedSlice }
  | { type: 'end' };

export async function* streamPackedContextNdjson(
  packed: PackedContext,
): AsyncIterable<string> {
  const metadataFrameValue: MetadataFrameValue = {
    ...packed.metadata,
    failures: packed.failures,
  };
  const metadataFrame: NdjsonFrame = {
    type: 'metadata',
    value: metadataFrameValue,
  };
  yield JSON.stringify(metadataFrame) + '\n';

  for (const slice of packed.slices) {
    const sliceFrame: NdjsonFrame = { type: 'slice', value: slice };
    yield JSON.stringify(sliceFrame) + '\n';
  }

  const endFrame: NdjsonFrame = { type: 'end' };
  yield JSON.stringify(endFrame) + '\n';
}

export function streamOrJsonPackedContext(
  packed: PackedContext,
): { mode: 'json'; body: string } | { mode: 'ndjson'; stream: AsyncIterable<string> } {
  const json = JSON.stringify(packed);
  const byteLength = Buffer.byteLength(json, 'utf8');

  if (byteLength < NDJSON_STREAM_THRESHOLD_BYTES) {
    return { mode: 'json', body: json };
  }

  return { mode: 'ndjson', stream: streamPackedContextNdjson(packed) };
}
