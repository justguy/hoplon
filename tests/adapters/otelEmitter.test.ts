/**
 * OT1 — OpenTelemetry HoplonEmitter tests.
 *
 * Proof targets:
 *   1. Adapter emits correct OTEL spans for op lifecycle (start / end / error)
 *   2. assertEventIsContentFree applied + passes on every emitted event
 *   3. Counters + histograms wired for op duration, violation count, audit log row count
 *   4. No-op tracer + no-op meter → adapter works (opt-in observability)
 *   5. H13 verification: no forbidden substrings in accumulated span attribute values
 *
 * All tests use in-memory mock Tracer + Meter objects — no network, no SDK.
 */

import { describe, it, expect, beforeEach } from 'vitest';
import type { Tracer, Meter, Span, SpanOptions, SpanAttributes } from '@opentelemetry/api';
import { SpanStatusCode } from '@opentelemetry/api';
import { createOtelEmitter } from '../../src/hoplon/adapters/emitter/otel.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { HoplonEvent } from '../../src/hoplon/adapters/emitter.js';

// ---------------------------------------------------------------------------
// Minimal in-memory mock implementations of OTEL interfaces
// ---------------------------------------------------------------------------

interface CapturedSpan {
  name: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes?: SpanAttributes }>;
  status?: { code: number; message?: string };
  ended: boolean;
}

interface CapturedMetric {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

function makeMockSpan(name: string, startAttrs: SpanAttributes = {}): {
  span: Span;
  captured: CapturedSpan;
} {
  const captured: CapturedSpan = {
    name,
    attributes: { ...startAttrs },
    events: [],
    ended: false,
  };

  // Cast to Span via unknown to avoid strict SpanAttributeValue compatibility
  // checks — we capture attributes as Record<string, unknown> for test assertions.
  const span = {
    spanContext: () => ({
      traceId: 'mock-trace-id',
      spanId: 'mock-span-id',
      traceFlags: 0,
    }),
    setAttribute(key: string, value: unknown) {
      captured.attributes[key] = value;
      return span;
    },
    setAttributes(attrs: SpanAttributes) {
      for (const [k, v] of Object.entries(attrs)) {
        captured.attributes[k] = v;
      }
      return span;
    },
    addEvent(name: string, attrs?: SpanAttributes) {
      captured.events.push({ name, attributes: attrs });
      return span;
    },
    addLink: () => span,
    addLinks: () => span,
    setStatus(status: { code: number; message?: string }) {
      captured.status = { code: status.code, message: status.message };
      return span;
    },
    updateName(newName: string) {
      captured.name = newName;
      return span;
    },
    end(): void {
      captured.ended = true;
    },
    isRecording: () => true,
    recordException: () => { /* noop */ },
  } as unknown as Span;

  return { span, captured };
}

function makeMockTracer(): {
  tracer: Tracer;
  spans: CapturedSpan[];
} {
  const spans: CapturedSpan[] = [];

  // Cast through unknown to avoid TypeScript's strict overload-signature checking
  // on Tracer.startActiveSpan. The adapter only calls startSpan; startActiveSpan
  // is included for structural compatibility.
  const tracer = {
    startSpan(name: string, options?: SpanOptions, _context?: unknown): Span {
      const { span, captured } = makeMockSpan(
        name,
        (options?.attributes ?? {}) as SpanAttributes,
      );
      spans.push(captured);
      return span;
    },
    startActiveSpan(
      name: string,
      fnOrOptions: unknown,
      fnOrContext?: unknown,
      maybeFn?: unknown,
    ): unknown {
      const fn =
        typeof maybeFn === 'function'
          ? (maybeFn as (s: Span) => unknown)
          : typeof fnOrContext === 'function'
          ? (fnOrContext as (s: Span) => unknown)
          : (fnOrOptions as (s: Span) => unknown);
      const { span, captured } = makeMockSpan(name);
      spans.push(captured);
      return fn(span);
    },
  } as unknown as Tracer;

  return { tracer, spans };
}

function makeMockMeter(): {
  meter: Meter;
  counterRecords: CapturedMetric[];
  histogramRecords: CapturedMetric[];
} {
  const counterRecords: CapturedMetric[] = [];
  const histogramRecords: CapturedMetric[] = [];

  function makeCounter(name: string) {
    return {
      add(value: number, attrs: Record<string, unknown> = {}) {
        counterRecords.push({ name, value, attributes: attrs });
      },
    };
  }

  function makeHistogram(name: string) {
    return {
      record(value: number, attrs: Record<string, unknown> = {}) {
        histogramRecords.push({ name, value, attributes: attrs });
      },
    };
  }

  const noopObservable = {
    addCallback: () => { /* noop */ },
    removeCallback: () => { /* noop */ },
  };

  const meter: Meter = {
    createCounter: (name: string) => makeCounter(name) as ReturnType<Meter['createCounter']>,
    createUpDownCounter: (name: string) => makeCounter(name) as ReturnType<Meter['createUpDownCounter']>,
    createHistogram: (name: string) => makeHistogram(name) as ReturnType<Meter['createHistogram']>,
    createGauge: (name: string) => makeCounter(name) as ReturnType<Meter['createGauge']>,
    createObservableCounter: () => noopObservable as ReturnType<Meter['createObservableCounter']>,
    createObservableUpDownCounter: () => noopObservable as ReturnType<Meter['createObservableUpDownCounter']>,
    createObservableGauge: () => noopObservable as ReturnType<Meter['createObservableGauge']>,
    addBatchObservableCallback: () => { /* noop */ },
    removeBatchObservableCallback: () => { /* noop */ },
  };

  return { meter, counterRecords, histogramRecords };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const BASE_OP = 'createSnapshot' as const;

const START_EVENT: HoplonEvent = {
  op: BASE_OP,
  phase: 'start',
  engineId: 'engine-test-01',
  correlationId: 'corr-otel-test-001',
};

const END_EVENT: HoplonEvent = {
  op: BASE_OP,
  phase: 'end',
  durationMs: 120,
  classification: 'PASS',
  engineId: 'engine-test-01',
  correlationId: 'corr-otel-test-001',
};

const ERROR_EVENT: HoplonEvent = {
  op: BASE_OP,
  phase: 'error',
  durationMs: 45,
  classification: 'ERROR',
  errorCategory: 'adapter',
  errorKind: 'fs_write_failed',
  engineId: 'engine-test-01',
  correlationId: 'corr-otel-test-001',
};

const AUDIT_DIFF_START: HoplonEvent = {
  op: 'auditDiff',
  phase: 'start',
  engineId: 'engine-test-01',
  correlationId: 'corr-audit-002',
};

const AUDIT_DIFF_END: HoplonEvent = {
  op: 'auditDiff',
  phase: 'end',
  durationMs: 200,
  classification: 'BLOCK',
  engineId: 'engine-test-01',
  correlationId: 'corr-audit-002',
};

// ---------------------------------------------------------------------------
// 1. Span lifecycle tests
// ---------------------------------------------------------------------------

describe('OT1 — span lifecycle', () => {
  it('OT1-1: start event creates a span with correct name and structural attributes', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    emitter.emit(START_EVENT);

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.name).toBe('hoplon.createSnapshot');
    expect(span.attributes['hoplon.op']).toBe('createSnapshot');
    expect(span.attributes['hoplon.phase']).toBe('start');
    expect(span.attributes['hoplon.engine_id']).toBe('engine-test-01');
    expect(span.attributes['hoplon.correlation_id']).toBe('corr-otel-test-001');
    // Span should not be ended yet (end comes on 'end' phase)
    expect(span.ended).toBe(false);
  });

  it('OT1-2: end event ends the span with OK status', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    emitter.emit(START_EVENT);
    emitter.emit(END_EVENT);

    // Same correlationId → same span ended
    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.OK); // OK = 1
  });

  it('OT1-3: error event ends the span with ERROR status + hoplon.error span event', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    emitter.emit(START_EVENT);
    emitter.emit(ERROR_EVENT);

    expect(spans).toHaveLength(1);
    const span = spans[0]!;
    expect(span.ended).toBe(true);
    expect(span.status?.code).toBe(SpanStatusCode.ERROR); // ERROR = 2
    expect(span.status?.message).toBe('fs_write_failed');

    const errorSpanEvent = span.events.find((e) => e.name === 'hoplon.error');
    expect(errorSpanEvent).toBeDefined();
    // H13: only structural identifiers in span event attributes
    expect(errorSpanEvent!.attributes?.['exception.type']).toBe('fs_write_failed');
    expect(errorSpanEvent!.attributes?.['exception.hoplon.category']).toBe('adapter');
  });

  it('OT1-4: two different correlationIds produce two independent spans', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    emitter.emit(START_EVENT);
    emitter.emit(AUDIT_DIFF_START);
    emitter.emit(END_EVENT);
    emitter.emit(AUDIT_DIFF_END);

    expect(spans).toHaveLength(2);
    const snap = spans.find((s) => s.name === 'hoplon.createSnapshot')!;
    const audit = spans.find((s) => s.name === 'hoplon.auditDiff')!;
    expect(snap.ended).toBe(true);
    expect(audit.ended).toBe(true);
  });

  it('OT1-5: orphan end event (no paired start) creates and ends a span gracefully', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    // Emit end without a prior start — adapter must not throw
    expect(() => emitter.emit(END_EVENT)).not.toThrow();

    expect(spans).toHaveLength(1);
    expect(spans[0]!.ended).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 2. assertEventIsContentFree — applied on every emission
// ---------------------------------------------------------------------------

describe('OT1 — H13 assertEventIsContentFree on every event', () => {
  it('OT1-6: clean start event passes assertEventIsContentFree independently', () => {
    expect(() => assertEventIsContentFree(START_EVENT)).not.toThrow();
  });

  it('OT1-7: clean end event with durationMs passes assertEventIsContentFree independently', () => {
    expect(() => assertEventIsContentFree(END_EVENT)).not.toThrow();
  });

  it('OT1-8: clean error event passes assertEventIsContentFree independently', () => {
    expect(() => assertEventIsContentFree(ERROR_EVENT)).not.toThrow();
  });

  it('OT1-9: adapter silently swallows an event that fails assertEventIsContentFree (H13 guard at boundary)', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter, counterRecords } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    // Force an H13 violation: extra field (cast through unknown to bypass TS).
    const badEvent = {
      ...START_EVENT,
      symbolName: 'secretSymbol',
    } as unknown as HoplonEvent;

    // Emitter MUST NOT throw (fire-and-forget contract)
    expect(() => emitter.emit(badEvent)).not.toThrow();

    // No span or metric should have been created (assertEventIsContentFree
    // fires before any OTEL interaction)
    expect(spans).toHaveLength(0);
    expect(counterRecords).toHaveLength(0);
  });

  it('OT1-10: accumulated span attribute values contain no forbidden substrings (H13)', () => {
    const { tracer, spans } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    emitter.emit(START_EVENT);
    emitter.emit(END_EVENT);
    emitter.emit({
      op: 'auditDiff',
      phase: 'error',
      durationMs: 10,
      classification: 'ERROR',
      errorCategory: 'semantic',
      errorKind: 'contract_violation',
      engineId: 'engine-test-01',
      correlationId: 'corr-h13-check',
    });

    const forbidden = ['function', 'class', 'const ', 'import ', '//', '/*'];
    const allAttrValues = spans.flatMap((s) =>
      Object.values(s.attributes).map((v) => String(v ?? '')),
    );

    for (const val of allAttrValues) {
      for (const sub of forbidden) {
        expect(
          val.includes(sub),
          `forbidden substring "${sub}" found in span attribute value: "${val}"`,
        ).toBe(false);
      }
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Counters + histograms
// ---------------------------------------------------------------------------

describe('OT1 — metrics wiring', () => {
  let tracer: Tracer;
  let meter: Meter;
  let counterRecords: CapturedMetric[];
  let histogramRecords: CapturedMetric[];

  beforeEach(() => {
    const t = makeMockTracer();
    const m = makeMockMeter();
    tracer = t.tracer;
    meter = m.meter;
    counterRecords = m.counterRecords;
    histogramRecords = m.histogramRecords;
  });

  it('OT1-11: hoplon.op.count is incremented on every event', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(START_EVENT);
    emitter.emit(END_EVENT);
    emitter.emit(ERROR_EVENT);

    const opCounts = counterRecords.filter((r) => r.name === 'hoplon.op.count');
    expect(opCounts).toHaveLength(3);
  });

  it('OT1-12: hoplon.op.count tagged by op and phase', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(START_EVENT);

    const opCounts = counterRecords.filter((r) => r.name === 'hoplon.op.count');
    expect(opCounts).toHaveLength(1);
    expect(opCounts[0]!.attributes['hoplon.op']).toBe('createSnapshot');
    expect(opCounts[0]!.attributes['hoplon.phase']).toBe('start');
  });

  it('OT1-13: hoplon.op.duration_ms recorded on end event with correct value', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(START_EVENT);
    emitter.emit(END_EVENT); // durationMs: 120

    const durations = histogramRecords.filter((r) => r.name === 'hoplon.op.duration_ms');
    expect(durations).toHaveLength(1);
    expect(durations[0]!.value).toBe(120);
    expect(durations[0]!.attributes['hoplon.op']).toBe('createSnapshot');
  });

  it('OT1-14: hoplon.op.duration_ms NOT recorded on start event', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(START_EVENT);

    const durations = histogramRecords.filter((r) => r.name === 'hoplon.op.duration_ms');
    expect(durations).toHaveLength(0);
  });

  it('OT1-15: hoplon.op.duration_ms recorded on error event', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(START_EVENT);
    emitter.emit(ERROR_EVENT); // durationMs: 45

    const durations = histogramRecords.filter((r) => r.name === 'hoplon.op.duration_ms');
    expect(durations).toHaveLength(1);
    expect(durations[0]!.value).toBe(45);
  });

  it('OT1-16: hoplon.violation.count incremented on error event with errorKind', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(ERROR_EVENT); // errorKind: 'fs_write_failed'

    const violations = counterRecords.filter((r) => r.name === 'hoplon.violation.count');
    expect(violations).toHaveLength(1);
    expect(violations[0]!.attributes['kind']).toBe('fs_write_failed');
  });

  it('OT1-17: hoplon.violation.count NOT recorded on end event (no errorKind)', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(END_EVENT);

    const violations = counterRecords.filter((r) => r.name === 'hoplon.violation.count');
    expect(violations).toHaveLength(0);
  });

  it('OT1-18: multiple ops accumulate correct op counts independently', () => {
    const emitter = createOtelEmitter({ tracer, meter });
    emitter.emit(START_EVENT);       // createSnapshot start
    emitter.emit(AUDIT_DIFF_START);  // auditDiff start
    emitter.emit(END_EVENT);         // createSnapshot end
    emitter.emit(AUDIT_DIFF_END);    // auditDiff end

    const opCounts = counterRecords.filter((r) => r.name === 'hoplon.op.count');
    expect(opCounts).toHaveLength(4);

    const snapCounts = opCounts.filter((r) => r.attributes['hoplon.op'] === 'createSnapshot');
    const auditCounts = opCounts.filter((r) => r.attributes['hoplon.op'] === 'auditDiff');
    expect(snapCounts).toHaveLength(2);
    expect(auditCounts).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// 4. No-op tracer + no-op meter compatibility
// ---------------------------------------------------------------------------

describe('OT1 — no-op tracer and meter compatibility', () => {
  it('OT1-19: adapter works with fully passive (no-op) tracer and meter', () => {
    // Construct a fully passive implementation — simulates what the OTEL SDK
    // provides when no exporter is configured.
    // Use unknown-cast for noop objects to avoid strict `this` return-type issues
    // on Span methods (setAttribute, setStatus, etc. all return `this`).
    const noopSpan = {
      spanContext: () => ({ traceId: '', spanId: '', traceFlags: 0 }),
      setAttribute: () => noopSpan,
      setAttributes: () => noopSpan,
      addEvent: () => noopSpan,
      addLink: () => noopSpan,
      addLinks: () => noopSpan,
      setStatus: () => noopSpan,
      updateName: () => noopSpan,
      end: () => { /* noop */ },
      isRecording: () => false,
      recordException: () => { /* noop */ },
    } as unknown as Span;

    const noopTracer = {
      startSpan: () => noopSpan,
      startActiveSpan: (_name: string, fn: unknown): unknown => {
        if (typeof fn === 'function') return (fn as (span: Span) => unknown)(noopSpan);
        return undefined;
      },
    } as unknown as Tracer;

    const noopCounter = { add: () => { /* noop */ } };
    const noopHistogram = { record: () => { /* noop */ } };
    const noopObservable = {
      addCallback: () => { /* noop */ },
      removeCallback: () => { /* noop */ },
    };

    const noopMeter: Meter = {
      createCounter: () => noopCounter as ReturnType<Meter['createCounter']>,
      createUpDownCounter: () => noopCounter as ReturnType<Meter['createUpDownCounter']>,
      createHistogram: () => noopHistogram as ReturnType<Meter['createHistogram']>,
      createGauge: () => noopCounter as ReturnType<Meter['createGauge']>,
      createObservableCounter: () => noopObservable as ReturnType<Meter['createObservableCounter']>,
      createObservableUpDownCounter: () => noopObservable as ReturnType<Meter['createObservableUpDownCounter']>,
      createObservableGauge: () => noopObservable as ReturnType<Meter['createObservableGauge']>,
      addBatchObservableCallback: () => { /* noop */ },
      removeBatchObservableCallback: () => { /* noop */ },
    };

    const emitter = createOtelEmitter({ tracer: noopTracer, meter: noopMeter });

    // All three phases must complete without throwing
    expect(() => emitter.emit(START_EVENT)).not.toThrow();
    expect(() => emitter.emit(END_EVENT)).not.toThrow();
    expect(() => emitter.emit(ERROR_EVENT)).not.toThrow();
  });

  it('OT1-20: adapter satisfies HoplonEmitter interface (emit returns undefined)', () => {
    const { tracer } = makeMockTracer();
    const { meter } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });

    const result = emitter.emit(START_EVENT);
    expect(result).toBeUndefined();
  });
});
