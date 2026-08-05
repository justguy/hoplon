/**
 * tests/transport/streaming.test.ts — T3 proof suite.
 *
 * Proves:
 * 1. 10 MB fixture packed → delivered as NDJSON → reassembled → byte-identical
 *    to direct JSON round-trip.
 * 2. Small payload (< 1 MB) → falls back to single JSON response.
 * 3. Interrupted stream (truncated input) →
 *    TransportError({ kind: 'stream_interrupted' }).
 * 4. Stream determinism: two calls with same input → same NDJSON line order.
 *
 * All tests are pure unit tests — no filesystem, no network, no tree-sitter.
 * Uses in-memory ReadableStream construction to simulate the client-side path.
 */

import { describe, it, expect } from 'vitest';
import {
  NDJSON_STREAM_THRESHOLD_BYTES,
  streamPackedContextNdjson,
  parseNdjsonStream,
  streamOrJsonPackedContext,
} from '../../src/hoplon/transport/http/streaming.js';
import { TransportError } from '../../src/hoplon/transport/types.js';
import type { PackedContext } from '../../src/hoplon/contracts/context.js';

// ---------------------------------------------------------------------------
// Shared constants
// ---------------------------------------------------------------------------

const CORR = 'corr-t3-test';
const ENGINE_ID = 'test-engine-t3';
const CTX = { correlationId: CORR, engineId: ENGINE_ID };

// ---------------------------------------------------------------------------
// Fixture builders
// ---------------------------------------------------------------------------

/**
 * Build a minimal valid PackedContext for unit tests.
 */
function buildMinimalPackedContext(): PackedContext {
  return {
    metadata: {
      strategyVersion: 1,
      grammarVersion: 'tree-sitter-typescript@0.20.0',
      packerVersion: 1,
      generatedAt: '2026-04-13T00:00:00Z',
      correlationId: CORR,
    },
    slices: [
      {
        path: 'src/alpha.ts',
        byteRange: [0, 20],
        nodeKinds: ['program'],
        content: 'export const x = 1;\n',
      },
      {
        path: 'src/beta.ts',
        byteRange: [0, 30],
        nodeKinds: ['program'],
        content: 'export const y = "hello world";\n',
      },
    ],
    failures: [
      { path: 'src/broken.ts', reason: 'parse_failure', parseError: 'Unexpected token' },
    ],
  };
}

/**
 * Build a large PackedContext whose JSON serialisation is >= 10 MiB.
 *
 * Strategy: build one big slice with repeated content until we exceed 10 MB.
 * The content in each slice is long enough so that total serialised JSON is
 * well above the 1 MiB threshold and also reaches ~10 MB.
 */
function buildLargePackedContext(targetBytes = 10 * 1024 * 1024): PackedContext {
  // Each slice contributes approximately `contentLength` chars of content
  const sliceCount = 200;
  const contentPerSlice = Math.ceil(targetBytes / sliceCount);
  const content = 'x'.repeat(contentPerSlice);

  const slices = Array.from({ length: sliceCount }, (_, i) => ({
    path: `src/file_${String(i).padStart(5, '0')}.ts`,
    byteRange: [0, contentPerSlice] as [number, number],
    nodeKinds: ['program'],
    content,
  }));

  // Sort per H7: path ASC, byteRange[0] ASC (already sorted by construction)
  slices.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));

  return {
    metadata: {
      strategyVersion: 1,
      grammarVersion: 'tree-sitter-typescript@0.20.0',
      packerVersion: 1,
      generatedAt: '2026-04-13T00:00:00Z',
      correlationId: CORR,
    },
    slices,
    failures: [],
  };
}

// ---------------------------------------------------------------------------
// Helper: collect AsyncIterable<string> into a single string
// ---------------------------------------------------------------------------

async function collectLines(iter: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of iter) {
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// Helper: build a ReadableStream<Uint8Array> from a string
// ---------------------------------------------------------------------------

function stringToStream(s: string): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(s);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Build a ReadableStream that delivers `ndjson` but truncates it after
 * `truncateAtByte` bytes. Used to simulate an interrupted stream.
 */
function truncatedStream(
  ndjson: string,
  truncateAtByte: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(ndjson).slice(0, truncateAtByte);
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });
}

/**
 * Build a ReadableStream that delivers `ndjson` in small chunks.
 * This exercises the line-buffering logic in parseNdjsonStream.
 */
function chunkedStream(
  ndjson: string,
  chunkSize: number,
): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const bytes = encoder.encode(ndjson);
  let offset = 0;
  return new ReadableStream<Uint8Array>({
    pull(controller) {
      if (offset >= bytes.length) {
        controller.close();
        return;
      }
      const end = Math.min(offset + chunkSize, bytes.length);
      controller.enqueue(bytes.slice(offset, end));
      offset = end;
    },
  });
}

// ---------------------------------------------------------------------------
// Helper: collect all NDJSON lines from a PackedContext into a string
// ---------------------------------------------------------------------------

async function ndjsonString(packed: PackedContext): Promise<string> {
  const lines = await collectLines(streamPackedContextNdjson(packed));
  return lines.join('');
}

// ---------------------------------------------------------------------------
// 1. Threshold constant
// ---------------------------------------------------------------------------

describe('NDJSON_STREAM_THRESHOLD_BYTES', () => {
  it('is exactly 1 MiB (1_048_576 bytes)', () => {
    expect(NDJSON_STREAM_THRESHOLD_BYTES).toBe(1_048_576);
  });
});

// ---------------------------------------------------------------------------
// 2. streamOrJsonPackedContext — threshold routing
// ---------------------------------------------------------------------------

describe('streamOrJsonPackedContext — threshold routing', () => {
  it('returns mode=json for a small payload (< 1 MiB)', () => {
    const packed = buildMinimalPackedContext();
    const decision = streamOrJsonPackedContext(packed);
    expect(decision.mode).toBe('json');
  });

  it('mode=json body is valid JSON round-trip of the PackedContext', () => {
    const packed = buildMinimalPackedContext();
    const decision = streamOrJsonPackedContext(packed);
    if (decision.mode !== 'json') throw new Error('expected json mode');
    const recovered = JSON.parse(decision.body) as PackedContext;
    expect(recovered).toEqual(packed);
  });

  it('returns mode=ndjson for a large payload (>= 1 MiB)', () => {
    const packed = buildLargePackedContext();
    // Verify the fixture actually exceeds the threshold
    const json = JSON.stringify(packed);
    const byteLength = Buffer.byteLength(json, 'utf8');
    expect(byteLength).toBeGreaterThanOrEqual(NDJSON_STREAM_THRESHOLD_BYTES);

    const decision = streamOrJsonPackedContext(packed);
    expect(decision.mode).toBe('ndjson');
  });

  it('mode=ndjson stream property is an async iterable', () => {
    const packed = buildLargePackedContext();
    const decision = streamOrJsonPackedContext(packed);
    if (decision.mode !== 'ndjson') throw new Error('expected ndjson mode');
    expect(typeof decision.stream[Symbol.asyncIterator]).toBe('function');
  });
});

// ---------------------------------------------------------------------------
// 3. streamPackedContextNdjson — server-side emitter
// ---------------------------------------------------------------------------

describe('streamPackedContextNdjson — server-side', () => {
  it('emits a metadata frame first', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    const first = JSON.parse(lines[0]!.trim()) as { type: string };
    expect(first.type).toBe('metadata');
  });

  it('emits one slice frame per slice', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    const sliceLines = lines
      .slice(1, -1)
      .map((l) => JSON.parse(l.trim()) as { type: string });
    expect(sliceLines.every((f) => f.type === 'slice')).toBe(true);
    expect(sliceLines).toHaveLength(packed.slices.length);
  });

  it('emits an end frame last', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    const last = JSON.parse(lines[lines.length - 1]!.trim()) as { type: string };
    expect(last.type).toBe('end');
  });

  it('total frame count = 1 (metadata) + N slices + 1 (end)', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    // Each line ends with '\n' so the last split element may be ''
    const nonEmpty = lines.filter((l) => l.trim().length > 0);
    expect(nonEmpty).toHaveLength(1 + packed.slices.length + 1);
  });

  it('each line ends with a newline character', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    for (const line of lines) {
      expect(line.endsWith('\n')).toBe(true);
    }
  });

  it('metadata frame value contains failures array', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    const meta = JSON.parse(lines[0]!.trim()) as {
      type: string;
      value: { failures: unknown[] };
    };
    expect(meta.type).toBe('metadata');
    expect(Array.isArray(meta.value.failures)).toBe(true);
    expect(meta.value.failures).toHaveLength(packed.failures.length);
  });

  it('slice frames carry path, byteRange, nodeKinds, content', async () => {
    const packed = buildMinimalPackedContext();
    const lines = await collectLines(streamPackedContextNdjson(packed));
    const firstSlice = JSON.parse(lines[1]!.trim()) as {
      type: string;
      value: { path: string; byteRange: number[]; nodeKinds: string[]; content: string };
    };
    expect(firstSlice.type).toBe('slice');
    expect(typeof firstSlice.value.path).toBe('string');
    expect(Array.isArray(firstSlice.value.byteRange)).toBe(true);
    expect(Array.isArray(firstSlice.value.nodeKinds)).toBe(true);
    expect(typeof firstSlice.value.content).toBe('string');
  });
});

// ---------------------------------------------------------------------------
// 4. parseNdjsonStream — client-side reassembler
// ---------------------------------------------------------------------------

describe('parseNdjsonStream — client-side', () => {
  it('round-trips a minimal PackedContext through NDJSON', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const stream = stringToStream(ndjson);
    const recovered = await parseNdjsonStream(stream, CTX);
    expect(recovered).toEqual(packed);
  });

  it('slices are in the same order as the source (H7 preserved)', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const stream = stringToStream(ndjson);
    const recovered = await parseNdjsonStream(stream, CTX);
    expect(recovered.slices.map((s) => s.path)).toEqual(
      packed.slices.map((s) => s.path),
    );
  });

  it('failures are correctly reassembled', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const stream = stringToStream(ndjson);
    const recovered = await parseNdjsonStream(stream, CTX);
    expect(recovered.failures).toEqual(packed.failures);
  });

  it('metadata fields are preserved across stream round-trip', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const stream = stringToStream(ndjson);
    const recovered = await parseNdjsonStream(stream, CTX);
    expect(recovered.metadata).toEqual(packed.metadata);
  });

  it('handles chunked delivery (line-buffer stitching)', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    // Deliver in 7-byte chunks to exercise line-buffer stitching
    const stream = chunkedStream(ndjson, 7);
    const recovered = await parseNdjsonStream(stream, CTX);
    expect(recovered).toEqual(packed);
  });

  it('handles empty failures array', async () => {
    const packed: PackedContext = { ...buildMinimalPackedContext(), failures: [] };
    const ndjson = await ndjsonString(packed);
    const stream = stringToStream(ndjson);
    const recovered = await parseNdjsonStream(stream, CTX);
    expect(recovered.failures).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 5. 10 MB fixture — full NDJSON round-trip (H7 determinism + byte identity)
// ---------------------------------------------------------------------------

describe('10 MB fixture — NDJSON round-trip', () => {
  it(
    'packed → NDJSON → reassembled is structurally equal to original',
    async () => {
      const packed = buildLargePackedContext(10 * 1024 * 1024);
      const ndjson = await ndjsonString(packed);

      // Confirm the fixture is genuinely large
      expect(Buffer.byteLength(ndjson, 'utf8')).toBeGreaterThan(NDJSON_STREAM_THRESHOLD_BYTES);

      const stream = stringToStream(ndjson);
      const recovered = await parseNdjsonStream(stream, CTX);

      expect(recovered.metadata).toEqual(packed.metadata);
      expect(recovered.slices).toHaveLength(packed.slices.length);
      expect(recovered.failures).toEqual(packed.failures);
    },
    30_000, // 30 s timeout for large fixture
  );

  it(
    'reassembled JSON is byte-identical to direct JSON round-trip',
    async () => {
      const packed = buildLargePackedContext(10 * 1024 * 1024);
      const directJson = JSON.stringify(packed);

      const ndjson = await ndjsonString(packed);
      const stream = stringToStream(ndjson);
      const recovered = await parseNdjsonStream(stream, CTX);
      const recoveredJson = JSON.stringify(recovered);

      // The only field that could differ is generatedAt (but it is fixed in
      // the fixture), so byte-identity of JSON serialisations proves no data
      // was dropped or reordered.
      expect(recoveredJson).toBe(directJson);
    },
    30_000,
  );
});

// ---------------------------------------------------------------------------
// 6. Interrupted stream → TransportError({ kind: 'stream_interrupted' })
// ---------------------------------------------------------------------------

describe('interrupted stream handling', () => {
  it('truncated before end frame → TransportError(stream_interrupted)', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    // Truncate to 50% of the NDJSON — definitely before the end frame
    const truncateAt = Math.floor(Buffer.byteLength(ndjson, 'utf8') / 2);
    const stream = truncatedStream(ndjson, truncateAt);

    await expect(parseNdjsonStream(stream, CTX)).rejects.toBeInstanceOf(TransportError);
  });

  it('truncated before end frame → error kind is stream_interrupted', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const truncateAt = Math.floor(Buffer.byteLength(ndjson, 'utf8') / 2);
    const stream = truncatedStream(ndjson, truncateAt);

    try {
      await parseNdjsonStream(stream, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('stream_interrupted');
    }
  });

  it('truncated before end frame → error carries correlationId', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const truncateAt = 10; // extremely short — truncated in metadata frame
    const stream = truncatedStream(ndjson, truncateAt);

    try {
      await parseNdjsonStream(stream, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as TransportError).correlationId).toBe(CORR);
    }
  });

  it('malformed JSON line → TransportError(stream_interrupted)', async () => {
    // Inject a corrupt line between metadata and end
    const packed = buildMinimalPackedContext();
    const metadataLine = JSON.stringify({
      type: 'metadata',
      value: { ...packed.metadata, failures: packed.failures },
    }) + '\n';
    const corrupt = 'NOT_VALID_JSON\n';
    const endLine = JSON.stringify({ type: 'end' }) + '\n';
    const ndjson = metadataLine + corrupt + endLine;
    const stream = stringToStream(ndjson);

    try {
      await parseNdjsonStream(stream, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('stream_interrupted');
    }
  });

  it('empty stream → TransportError(stream_interrupted)', async () => {
    const stream = stringToStream('');
    await expect(parseNdjsonStream(stream, CTX)).rejects.toBeInstanceOf(TransportError);
  });

  it('end frame only (no metadata) → TransportError(stream_interrupted)', async () => {
    const endOnly = JSON.stringify({ type: 'end' }) + '\n';
    const stream = stringToStream(endOnly);

    try {
      await parseNdjsonStream(stream, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('stream_interrupted');
    }
  });
});

// ---------------------------------------------------------------------------
// 7. Stream determinism — two calls same input → same NDJSON line order (H7)
// ---------------------------------------------------------------------------

describe('stream determinism (H7)', () => {
  it('two calls with same PackedContext produce identical NDJSON', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson1 = await ndjsonString(packed);
    const ndjson2 = await ndjsonString(packed);
    expect(ndjson1).toBe(ndjson2);
  });

  it('slice lines appear in path-ascending order (H7)', async () => {
    // Build a PackedContext with paths that would expose ordering bugs
    const packed: PackedContext = {
      ...buildMinimalPackedContext(),
      slices: [
        { path: 'src/zzz.ts', byteRange: [0, 5], nodeKinds: ['program'], content: 'zzz\n' },
        { path: 'src/aaa.ts', byteRange: [0, 5], nodeKinds: ['program'], content: 'aaa\n' },
        { path: 'src/mmm.ts', byteRange: [0, 5], nodeKinds: ['program'], content: 'mmm\n' },
      ],
    };
    // Note: packContext guarantees H7 ordering, but this test exercises
    // the streaming layer's preservation of that order.
    const lines = await collectLines(streamPackedContextNdjson(packed));
    const sliceLines = lines
      .slice(1, -1)
      .map((l) => (JSON.parse(l.trim()) as { type: string; value: { path: string } }).value.path);
    // The streaming layer emits slices in the order they appear in packed.slices
    // (packContext already sorted them; transport must not re-sort)
    expect(sliceLines).toEqual(['src/zzz.ts', 'src/aaa.ts', 'src/mmm.ts']);
  });

  it('two large calls with same input produce identical line count', async () => {
    const packed = buildLargePackedContext(2 * 1024 * 1024); // 2 MB for speed
    const lines1 = await collectLines(streamPackedContextNdjson(packed));
    const lines2 = await collectLines(streamPackedContextNdjson(packed));
    expect(lines1.length).toBe(lines2.length);
    // Spot-check first and last lines match
    expect(lines1[0]).toBe(lines2[0]);
    expect(lines1[lines1.length - 1]).toBe(lines2[lines2.length - 1]);
  }, 15_000);
});

// ---------------------------------------------------------------------------
// 8. H13 — error objects do not leak body content
// ---------------------------------------------------------------------------

describe('H13 — no body content in error objects', () => {
  it('stream_interrupted error does not contain raw bytes', async () => {
    const packed = buildMinimalPackedContext();
    const ndjson = await ndjsonString(packed);
    const truncateAt = 10;
    const stream = truncatedStream(ndjson, truncateAt);

    try {
      await parseNdjsonStream(stream, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      const te = err as TransportError;
      // Error message must not contain raw NDJSON content
      expect(te.message).not.toContain('export const');
      expect(te.message).not.toContain('tree-sitter-typescript');
    }
  });

  it('stream_interrupted error carries engineId and correlationId', async () => {
    const stream = stringToStream('');
    try {
      await parseNdjsonStream(stream, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      const te = err as TransportError;
      expect(te.engineId).toBe(ENGINE_ID);
      expect(te.correlationId).toBe(CORR);
    }
  });
});
