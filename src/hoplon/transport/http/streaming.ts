/** NDJSON transport facade for large PackedContext responses. */

export {
  NDJSON_STREAM_THRESHOLD_BYTES,
  streamOrJsonPackedContext,
  streamPackedContextNdjson,
} from './streamingFrames.js';
export type { MetadataFrameValue, NdjsonFrame } from './streamingFrames.js';
export { parseNdjsonStream } from './streamingParser.js';
