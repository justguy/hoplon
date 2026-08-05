/**
 * adapters/emitter/otel.ts — OpenTelemetry HoplonEmitter (OT1).
 *
 * Creates a HoplonEmitter that maps HoplonEvent → OTEL spans, counters, and
 * histograms. Consumers supply their own Tracer and Meter via the factory
 * options — this adapter performs NO transport configuration; it is pure
 * in-process emission. The host's OTEL SDK (configured separately) routes
 * telemetry to whatever backend it uses.
 *
 * H13 invariant preserved:
 *   assertEventIsContentFree is applied to EVERY event before emission.
 *   Only structural fields (op, phase, IDs, correlationId, durationMs,
 *   classification, taxonomy labels, error class, and numeric counts) land
 *   in OTEL span attributes. Symbol names, file paths, source slices, and
 *   manifest entries NEVER appear in attributes.
 *
 * Metric shape:
 *   Counter   hoplon.op.count            — tagged by op, phase
 *   Histogram hoplon.op.duration_ms      — tagged by op (recorded on end/error)
 *   Counter   hoplon.violation.count     — tagged by kind (on error phase with errorKind)
 *   Counter   hoplon.audit_log.rows      — tagged by op (when auditRowCount is present)
 *   Counter   hoplon.policy.decision.count — tagged by closed decision class
 *
 * Span lifecycle:
 *   'start' phase → startSpan (span stored in per-correlationId map)
 *   'end'   phase → span.end() + span.setStatus(OK)
 *   'error' phase → span.recordException + span.setStatus(ERROR) + span.end()
 *
 * No-op tracer / no-op meter: the adapter compiles to a no-op when the host
 * supplies OTEL no-op implementations (the default when no SDK is configured).
 */

import type { Tracer, Meter, Span, SpanAttributes } from '@opentelemetry/api';
import { SpanStatusCode as OtelSpanStatusCode } from '@opentelemetry/api';
import type { HoplonEmitter, HoplonEvent } from '../emitter.js';
import { assertEventIsContentFree } from './assert.js';

// ---------------------------------------------------------------------------
// Public factory options
// ---------------------------------------------------------------------------

export interface OtelEmitterOptions {
  /**
   * OTEL Tracer instance. Consumers obtain this from their OTEL SDK:
   *   const tracer = trace.getTracer('hoplon', '0.1.0');
   * Pass a no-op tracer (from @opentelemetry/api's default global) to disable
   * span emission without disabling metrics.
   */
  readonly tracer: Tracer;

  /**
   * OTEL Meter instance. Consumers obtain this from their OTEL SDK:
   *   const meter = metrics.getMeter('hoplon', '0.1.0');
   * Pass a no-op meter to disable metric emission without disabling spans.
   */
  readonly meter: Meter;
}

// ---------------------------------------------------------------------------
// Attribute key constants (H13: no content ever touches these paths)
// ---------------------------------------------------------------------------

const ATTR_OP = 'hoplon.op' as const;
const ATTR_PHASE = 'hoplon.phase' as const;
const ATTR_ENGINE_ID = 'hoplon.engine_id' as const;
const ATTR_PROJECT_ID = 'hoplon.project_id' as const;
const ATTR_RUN_ID = 'hoplon.run_id' as const;
const ATTR_CORRELATION_ID = 'hoplon.correlation_id' as const;
const ATTR_CLASSIFICATION = 'hoplon.classification' as const;
const ATTR_OPERATION_KIND = 'hoplon.operation_kind' as const;
const ATTR_POLICY_DECISION_CLASS = 'hoplon.policy_decision_class' as const;
const ATTR_ERROR_CATEGORY = 'hoplon.error_category' as const;
const ATTR_ERROR_KIND = 'hoplon.error_kind' as const;
const COUNT_ATTRS = {
  inputCount: 'hoplon.count.input',
  outputCount: 'hoplon.count.output',
  resultCount: 'hoplon.count.result',
  fileCount: 'hoplon.count.file',
  changedFileCount: 'hoplon.count.changed_file',
  subjectCount: 'hoplon.count.subject',
  documentCount: 'hoplon.count.document',
  violationCount: 'hoplon.count.violation',
  auditRowCount: 'hoplon.count.audit_row',
  byteCount: 'hoplon.count.byte',
  attemptCount: 'hoplon.count.attempt',
} as const;

// Metric names
const METRIC_OP_COUNT = 'hoplon.op.count' as const;
const METRIC_OP_DURATION_MS = 'hoplon.op.duration_ms' as const;
const METRIC_VIOLATION_COUNT = 'hoplon.violation.count' as const;
const METRIC_AUDIT_LOG_ROWS = 'hoplon.audit_log.rows' as const;
const METRIC_POLICY_DECISION_COUNT = 'hoplon.policy.decision.count' as const;

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Create an OpenTelemetry HoplonEmitter.
 *
 * @param options - Tracer and Meter from the host's OTEL SDK.
 * @returns HoplonEmitter that emits OTEL spans + metrics.
 *
 * Implementation notes:
 * - Errors in OTEL emission are caught and silently swallowed per the
 *   HoplonEmitter contract (emitters MUST NOT propagate errors).
 * - assertEventIsContentFree is called before ANY OTEL interaction.
 *   If it throws (H13 violation), the error is also swallowed at the
 *   emitter boundary — but the violation is recorded on the active span
 *   as a span event (structure-only: no content in the event attributes).
 */
export function createOtelEmitter(options: OtelEmitterOptions): HoplonEmitter {
  const { tracer, meter } = options;

  // Instrument creation (lazy but synchronous — safe to create at factory time).
  const opCounter = meter.createCounter(METRIC_OP_COUNT, {
    description: 'Number of Hoplon operations by op and phase',
    unit: '{operation}',
  });

  const durationHistogram = meter.createHistogram(METRIC_OP_DURATION_MS, {
    description: 'Duration of Hoplon operations in milliseconds',
    unit: 'ms',
  });

  const violationCounter = meter.createCounter(METRIC_VIOLATION_COUNT, {
    description: 'Number of Hoplon audit violations by kind',
    unit: '{violation}',
  });

  const auditLogRowsCounter = meter.createCounter(METRIC_AUDIT_LOG_ROWS, {
    description: 'Number of audit log rows written by op',
    unit: '{row}',
  });

  const policyDecisionCounter = meter.createCounter(METRIC_POLICY_DECISION_COUNT, {
    description: 'Number of Hoplon policy decisions by closed decision class',
    unit: '{decision}',
  });

  // Active span map: correlationId + op + operationKind → Span.
  const activeSpans = new Map<string, Span>();

  return {
    emit(event: HoplonEvent): void {
      try {
        // H13 guard — must run before ANY attribute construction.
        assertEventIsContentFree(event);

        // Structural attributes only (H13: no symbol names, paths, or content).
        const baseAttrs: SpanAttributes = {
          [ATTR_OP]: event.op,
          [ATTR_PHASE]: event.phase,
          [ATTR_ENGINE_ID]: event.engineId,
          [ATTR_CORRELATION_ID]: event.correlationId,
        };

        if (event.projectId !== undefined) {
          baseAttrs[ATTR_PROJECT_ID] = event.projectId;
        }
        if (event.runId !== undefined) {
          baseAttrs[ATTR_RUN_ID] = event.runId;
        }
        if (event.classification !== undefined) {
          baseAttrs[ATTR_CLASSIFICATION] = event.classification;
        }
        if (event.operationKind !== undefined) {
          baseAttrs[ATTR_OPERATION_KIND] = event.operationKind;
        }
        if (event.policyDecisionClass !== undefined) {
          baseAttrs[ATTR_POLICY_DECISION_CLASS] = event.policyDecisionClass;
        }
        if (event.errorCategory !== undefined) {
          baseAttrs[ATTR_ERROR_CATEGORY] = event.errorCategory;
        }
        if (event.errorKind !== undefined) {
          baseAttrs[ATTR_ERROR_KIND] = event.errorKind;
        }
        for (const [field, attr] of Object.entries(COUNT_ATTRS)) {
          const value = event[field as keyof typeof COUNT_ATTRS];
          if (typeof value === 'number') {
            baseAttrs[attr] = value;
          }
        }

        // Metrics — op counter on every event.
        opCounter.add(1, {
          [ATTR_OP]: event.op,
          [ATTR_PHASE]: event.phase,
          ...(event.operationKind !== undefined
            ? { [ATTR_OPERATION_KIND]: event.operationKind }
            : {}),
        });

        // Duration histogram — record on 'end' and 'error' phases.
        if (
          (event.phase === 'end' || event.phase === 'error') &&
          event.durationMs !== undefined
        ) {
          durationHistogram.record(event.durationMs, {
            [ATTR_OP]: event.op,
            ...(event.operationKind !== undefined
              ? { [ATTR_OPERATION_KIND]: event.operationKind }
              : {}),
          });
        }

        // Violation counter — record on 'error' phase when errorKind is present.
        if (event.phase === 'error' && event.errorKind !== undefined) {
          violationCounter.add(1, { kind: event.errorKind });
        }

        if (event.auditRowCount !== undefined) {
          auditLogRowsCounter.add(event.auditRowCount, { [ATTR_OP]: event.op });
        }

        if (event.policyDecisionClass !== undefined) {
          policyDecisionCounter.add(1, {
            [ATTR_POLICY_DECISION_CLASS]: event.policyDecisionClass,
          });
        }

        // Span lifecycle.
        handleSpan(tracer, activeSpans, event, baseAttrs);
      } catch {
        // HoplonEmitter contract: errors must NEVER propagate to the caller.
        // Swallow silently.
      }
    },
  };
}

// ---------------------------------------------------------------------------
// Span lifecycle helpers
// ---------------------------------------------------------------------------

/**
 * Handle OTEL span lifecycle based on event phase.
 *
 * - 'start': create and store a new span.
 * - 'end':   set OK status, end the span.
 * - 'error': record exception structure (structure-only!), set ERROR status, end span.
 */
function handleSpan(
  tracer: Tracer,
  activeSpans: Map<string, Span>,
  event: HoplonEvent,
  attrs: SpanAttributes,
): void {
  const spanName = `hoplon.${event.op}`;
  const key = spanKey(event);

  if (event.phase === 'start') {
    const span = tracer.startSpan(spanName, { attributes: attrs });
    activeSpans.set(key, span);
    return;
  }

  // Retrieve the paired span (may be absent if 'start' was not emitted —
  // tolerate gracefully by starting a new span in-flight).
  let span = activeSpans.get(key);
  if (span === undefined) {
    span = tracer.startSpan(spanName, { attributes: attrs });
  } else {
    // Add terminal attributes to the existing span.
    span.setAttributes(attrs);
    activeSpans.delete(key);
  }

  if (event.phase === 'end') {
    span.setStatus({ code: OtelSpanStatusCode.OK });
    span.end();
  } else {
    // phase === 'error'
    // recordException accepts an Error or a plain object with a message.
    // H13: we record only structural identifiers — no source content.
    const exceptionAttrs: Record<string, string> = {};
    if (event.errorKind !== undefined) {
      exceptionAttrs['exception.type'] = event.errorKind;
    }
    if (event.errorCategory !== undefined) {
      exceptionAttrs['exception.hoplon.category'] = event.errorCategory;
    }
    span.addEvent('hoplon.error', exceptionAttrs);
    span.setStatus({
      code: OtelSpanStatusCode.ERROR,
      message: event.errorKind ?? 'unknown',
    });
    span.end();
  }
}

function spanKey(event: HoplonEvent): string {
  return `${event.correlationId}:${event.op}:${event.operationKind ?? 'operation'}`;
}
