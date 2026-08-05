/**
 * util/diagnosticEnvelope.ts — structured diagnostic prefix.
 *
 * Produces the envelope object prepended to log lines, audit results,
 * snapshot records, and any other diagnostic output (invariant H5:
 * engineId appears in all diagnostic output; H11: correlationId mandatory).
 */

export interface DiagnosticEnvelopeInput {
  /** Engine identity — mandatory in all output (invariant H5). */
  engineId: string;
  /** Mandatory trace ID (H11). */
  correlationId: string;
  /** Project context — included only when provided. */
  projectId?: string;
  /** Run context — included only when provided. */
  runId?: string;
  /** Operation name, e.g. 'createSnapshot', 'auditDiff'. */
  op: string;
}

export interface DiagnosticEnvelope {
  engineId: string;
  correlationId: string;
  op: string;
  /** Present only when projectId was provided in the input. */
  projectId?: string;
  /** Present only when runId was provided in the input. */
  runId?: string;
  /** ISO 8601 UTC timestamp at envelope construction time. */
  timestamp: string;
}

/**
 * Construct a diagnostic envelope for a given operation.
 * The envelope is a plain object — serialize it however the caller needs.
 */
export function diagnosticEnvelope(input: DiagnosticEnvelopeInput): DiagnosticEnvelope {
  const envelope: DiagnosticEnvelope = {
    engineId: input.engineId,
    correlationId: input.correlationId,
    op: input.op,
    timestamp: new Date().toISOString(),
  };
  if (input.projectId !== undefined) {
    envelope.projectId = input.projectId;
  }
  if (input.runId !== undefined) {
    envelope.runId = input.runId;
  }
  return envelope;
}
