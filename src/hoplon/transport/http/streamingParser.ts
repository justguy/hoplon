import { PackedContextSchema } from '../../contracts/context.js';
import type { PackedContext, PackedSlice } from '../../contracts/context.js';
import { TransportError } from '../types.js';
import type { MetadataFrameValue, NdjsonFrame } from './streamingFrames.js';

interface StreamContext {
  correlationId: string;
  engineId: string;
}

export async function parseNdjsonStream(
  stream: ReadableStream<Uint8Array>,
  ctx: StreamContext,
): Promise<PackedContext> {
  const decoder = new TextDecoder('utf-8');
  const reader = stream.getReader();
  const state: { metadataValue: MetadataFrameValue | null } = {
    metadataValue: null,
  };
  const slices: PackedSlice[] = [];
  let receivedEnd = false;
  let lineBuffer = '';

  try {
    outer: while (true) {
      const { done, value } = await reader.read();
      if (done) {
        const remaining = lineBuffer.trim();
        if (remaining.length > 0) {
          const endSeen = parseLine(
            remaining,
            ctx,
            (metadata) => {
              state.metadataValue = metadata;
            },
            slices,
          );
          if (endSeen) receivedEnd = true;
        }
        break;
      }

      lineBuffer += decoder.decode(value, { stream: true });
      let newlineIndex: number;
      while ((newlineIndex = lineBuffer.indexOf('\n')) !== -1) {
        const line = lineBuffer.slice(0, newlineIndex);
        lineBuffer = lineBuffer.slice(newlineIndex + 1);
        if (line.trim().length === 0) continue;

        const endSeen = parseLine(
          line,
          ctx,
          (metadata) => {
            state.metadataValue = metadata;
          },
          slices,
        );
        if (endSeen) {
          receivedEnd = true;
          break outer;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }

  if (!receivedEnd) {
    throw new TransportError(
      {
        kind: 'stream_interrupted',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
      },
      'parseNdjsonStream: stream closed before {"type":"end"} frame',
    );
  }

  if (state.metadataValue === null) {
    throw new TransportError(
      {
        kind: 'stream_interrupted',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
      },
      'parseNdjsonStream: stream ended without a metadata frame',
    );
  }

  const metadata: MetadataFrameValue = state.metadataValue;
  const reassembled: unknown = {
    metadata: {
      strategyVersion: metadata.strategyVersion,
      grammarVersion: metadata.grammarVersion,
      packerVersion: metadata.packerVersion,
      generatedAt: metadata.generatedAt,
      correlationId: metadata.correlationId,
    },
    slices,
    failures: metadata.failures,
  };
  const parsed = PackedContextSchema.safeParse(reassembled);
  if (!parsed.success) {
    throw new TransportError(
      {
        kind: 'malformed_response',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
        cause: parsed.error,
      },
      `parseNdjsonStream: reassembled PackedContext failed schema validation: ${parsed.error.message}`,
    );
  }
  return parsed.data;
}

function parseLine(
  line: string,
  ctx: StreamContext,
  setMetadata: (value: MetadataFrameValue) => void,
  slices: PackedSlice[],
): boolean {
  let raw: unknown;
  try {
    raw = JSON.parse(line);
  } catch (cause) {
    throw new TransportError(
      {
        kind: 'stream_interrupted',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
        cause,
      },
      'parseNdjsonStream: NDJSON line is not valid JSON',
    );
  }

  const frame = raw as NdjsonFrame;
  if (frame.type === 'metadata') {
    setMetadata(frame.value);
  } else if (frame.type === 'slice') {
    slices.push(frame.value);
  } else if (frame.type === 'end') {
    return true;
  }
  return false;
}
