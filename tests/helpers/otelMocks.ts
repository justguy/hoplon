import type { Meter, Span, SpanAttributes, SpanOptions, Tracer } from '@opentelemetry/api';

export interface CapturedSpan {
  name: string;
  attributes: Record<string, unknown>;
  events: Array<{ name: string; attributes?: SpanAttributes }>;
  status?: { code: number; message?: string };
  ended: boolean;
}

export interface CapturedMetric {
  name: string;
  value: number;
  attributes: Record<string, unknown>;
}

export function makeMockTracer(): { tracer: Tracer; spans: CapturedSpan[] } {
  const spans: CapturedSpan[] = [];
  const tracer = {
    startSpan(name: string, options?: SpanOptions): Span {
      const captured: CapturedSpan = {
        name,
        attributes: { ...((options?.attributes ?? {}) as SpanAttributes) },
        events: [],
        ended: false,
      };
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
          for (const [key, value] of Object.entries(attrs)) {
            captured.attributes[key] = value;
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
        end: () => {
          captured.ended = true;
        },
        isRecording: () => true,
        recordException: () => undefined,
      } as unknown as Span;
      spans.push(captured);
      return span;
    },
    startActiveSpan(_name: string, fn: unknown): unknown {
      if (typeof fn === 'function') return (fn as (span: Span) => unknown)({} as Span);
      return undefined;
    },
  } as unknown as Tracer;
  return { tracer, spans };
}

export function makeMockMeter(): {
  meter: Meter;
  counterRecords: CapturedMetric[];
  histogramRecords: CapturedMetric[];
} {
  const counterRecords: CapturedMetric[] = [];
  const histogramRecords: CapturedMetric[] = [];
  const counter = (name: string) => ({
    add(value: number, attributes: Record<string, unknown> = {}) {
      counterRecords.push({ name, value, attributes });
    },
  });
  const histogram = (name: string) => ({
    record(value: number, attributes: Record<string, unknown> = {}) {
      histogramRecords.push({ name, value, attributes });
    },
  });
  const observable = { addCallback: () => undefined, removeCallback: () => undefined };
  const meter: Meter = {
    createCounter: (name: string) => counter(name) as ReturnType<Meter['createCounter']>,
    createUpDownCounter: (name: string) => counter(name) as ReturnType<Meter['createUpDownCounter']>,
    createHistogram: (name: string) => histogram(name) as ReturnType<Meter['createHistogram']>,
    createGauge: (name: string) => counter(name) as ReturnType<Meter['createGauge']>,
    createObservableCounter: () => observable as ReturnType<Meter['createObservableCounter']>,
    createObservableUpDownCounter: () => observable as ReturnType<Meter['createObservableUpDownCounter']>,
    createObservableGauge: () => observable as ReturnType<Meter['createObservableGauge']>,
    addBatchObservableCallback: () => undefined,
    removeBatchObservableCallback: () => undefined,
  };
  return { meter, counterRecords, histogramRecords };
}
