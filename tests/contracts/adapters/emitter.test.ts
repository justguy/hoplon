/**
 * Contract tests for HoplonEmitter implementations — Slice C5.
 *
 * Tests: noop, console, and memory emitters plus assertEventIsContentFree.
 * Does NOT touch tests/contracts/emitter.test.ts (A3.1 schema tests).
 */

import { describe, it, expect, beforeEach } from 'vitest';
import { Writable } from 'node:stream';

import { createNoopEmitter } from '../../../src/hoplon/adapters/emitter/noop.js';
import { createConsoleEmitter } from '../../../src/hoplon/adapters/emitter/console.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../../src/hoplon/adapters/emitter/assert.js';
import { HoplonEventSchema } from '../../../src/hoplon/adapters/emitter.js';
import type { HoplonEvent } from '../../../src/hoplon/adapters/emitter.js';
import { ValidationError } from '../../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const VALID_EVENT: HoplonEvent = {
  op: 'createSnapshot',
  phase: 'start',
  engineId: 'local-0',
  correlationId: 'corr-abc-123',
};

const VALID_END_EVENT: HoplonEvent = {
  op: 'auditDiff',
  phase: 'end',
  engineId: 'local-0',
  correlationId: 'corr-def-456',
  durationMs: 42,
  classification: 'PASS',
};

/** Build a writable stream that collects written chunks as strings. */
function makeCapture(): { stream: Writable; lines: () => string[] } {
  const chunks: Buffer[] = [];
  const stream = new Writable({
    write(chunk: Buffer, _enc, cb) {
      chunks.push(chunk);
      cb();
    },
  });
  return {
    stream,
    lines: () =>
      Buffer.concat(chunks)
        .toString('utf8')
        .split('\n')
        .filter((l) => l.length > 0),
  };
}

// ---------------------------------------------------------------------------
// 1. Noop emitter
// ---------------------------------------------------------------------------

describe('createNoopEmitter', () => {
  it('1 — emit is a no-op (no observable side effects)', () => {
    const emitter = createNoopEmitter();
    // Should return undefined and not throw
    const result = emitter.emit(VALID_EVENT);
    expect(result).toBeUndefined();
  });

  it('2 — emit with malformed event does NOT throw (noop bypasses validation by design)', () => {
    const emitter = createNoopEmitter();
    // A plain object that violates the schema (extra field + wrong op)
    // Cast through unknown to satisfy the TypeScript parameter type —
    // the noop emitter contract is that it never validates.
    const malformed = {
      op: 'unknownOp',
      phase: 'start',
      engineId: 'local-0',
      correlationId: 'corr-x',
      symbolName: 'forbidden',
    } as unknown as HoplonEvent;
    expect(() => emitter.emit(malformed)).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// 2. Console emitter
// ---------------------------------------------------------------------------

describe('createConsoleEmitter', () => {
  it('3 — valid event writes a single JSON line to the stream', () => {
    const { stream, lines } = makeCapture();
    const emitter = createConsoleEmitter({ stream });
    emitter.emit(VALID_EVENT);
    expect(lines()).toHaveLength(1);
  });

  it('4 — multiple events produce multiple JSON lines', () => {
    const { stream, lines } = makeCapture();
    const emitter = createConsoleEmitter({ stream });
    emitter.emit(VALID_EVENT);
    emitter.emit(VALID_END_EVENT);
    expect(lines()).toHaveLength(2);
  });

  it('5 — malformed event (extra field symbolName) throws at emit time', () => {
    const { stream } = makeCapture();
    const emitter = createConsoleEmitter({ stream });
    const malformed = {
      ...VALID_EVENT,
      symbolName: 'forbidden',
    } as unknown as HoplonEvent;
    expect(() => emitter.emit(malformed)).toThrow();
  });

  it('6 — each written line is valid JSON that round-trips through HoplonEventSchema', () => {
    const { stream, lines } = makeCapture();
    const emitter = createConsoleEmitter({ stream });
    emitter.emit(VALID_EVENT);
    emitter.emit(VALID_END_EVENT);
    for (const line of lines()) {
      const parsed = JSON.parse(line) as unknown;
      expect(HoplonEventSchema.safeParse(parsed).success).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Memory emitter
// ---------------------------------------------------------------------------

describe('createMemoryEmitter', () => {
  let emitter: ReturnType<typeof createMemoryEmitter>;

  beforeEach(() => {
    emitter = createMemoryEmitter();
  });

  it('7 — emit + getEvents returns events in insertion order', () => {
    emitter.emit(VALID_EVENT);
    emitter.emit(VALID_END_EVENT);
    const events = emitter.getEvents();
    expect(events).toHaveLength(2);
    expect(events[0]?.correlationId).toBe('corr-abc-123');
    expect(events[1]?.correlationId).toBe('corr-def-456');
  });

  it('8 — getEvents returns a defensive copy (mutation does not affect future calls)', () => {
    emitter.emit(VALID_EVENT);
    const first = emitter.getEvents();
    // Mutate the returned array
    first.push(VALID_END_EVENT);
    // Internal store must be unchanged
    const second = emitter.getEvents();
    expect(second).toHaveLength(1);
  });

  it('9 — clear empties the store', () => {
    emitter.emit(VALID_EVENT);
    emitter.emit(VALID_END_EVENT);
    emitter.clear();
    expect(emitter.getEvents()).toHaveLength(0);
  });

  it('10 — malformed event throws at emit time', () => {
    const malformed = {
      ...VALID_EVENT,
      symbolName: 'forbidden',
    } as unknown as HoplonEvent;
    expect(() => emitter.emit(malformed)).toThrow();
    // Nothing was stored
    expect(emitter.getEvents()).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// 4. assertEventIsContentFree
// ---------------------------------------------------------------------------

describe('assertEventIsContentFree', () => {
  it('11 — a clean event (only counts/ids/enums) passes without throwing', () => {
    expect(() => assertEventIsContentFree(VALID_EVENT)).not.toThrow();
    expect(() => assertEventIsContentFree(VALID_END_EVENT)).not.toThrow();
  });

  it('12 — an event with a symbolName field fails (forbidden field name)', () => {
    const bad = {
      ...VALID_EVENT,
      symbolName: '',
    };
    expect(() => assertEventIsContentFree(bad)).toThrow(ValidationError);
  });

  it('13 — an event with a field value >256 chars fails', () => {
    // engineId is a schema field, so it passes .strict() — but a long value
    // should still be caught by assertEventIsContentFree's value-length check
    const longValue = 'a'.repeat(257);
    const bad = {
      ...VALID_EVENT,
      engineId: longValue,
    };
    expect(() => assertEventIsContentFree(bad)).toThrow(ValidationError);
  });

  it('14 — an event with a code-like substring in any field value fails', () => {
    const bad = {
      ...VALID_EVENT,
      engineId: 'function foo() {',
    };
    expect(() => assertEventIsContentFree(bad)).toThrow(ValidationError);
  });

  it('14b — various code substrings are blocked', () => {
    const subs = ['class ', 'const ', 'import ', '//', '/*'];
    for (const sub of subs) {
      const bad = { ...VALID_EVENT, engineId: `${sub}something` };
      expect(() => assertEventIsContentFree(bad), `should block: ${sub}`).toThrow(
        ValidationError,
      );
    }
  });

  it('15 — forbidden content-like field names are blocked', () => {
    const forbiddenNames = [
      'sourceSlice',
      'content',
      'text',
      'body',
      'manifest',
      'files',
      'paths',
    ];
    for (const name of forbiddenNames) {
      const bad = { ...VALID_EVENT, [name]: '' };
      expect(() => assertEventIsContentFree(bad), `should block: ${name}`).toThrow(
        ValidationError,
      );
    }
  });

  it('15b — "code" field name is blocked', () => {
    const bad = { ...VALID_EVENT, code: '' };
    expect(() => assertEventIsContentFree(bad)).toThrow(ValidationError);
  });
});
