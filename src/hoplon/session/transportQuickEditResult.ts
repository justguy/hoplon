import type { QuickEditResult } from './quickEdit.js';
import type { QuickEditResultData } from './transportContracts.js';
import { SessionError, toSessionErrorTransportDetails } from './errors.js';

/**
 * Translate the in-process `QuickEditResult` (which carries a raw `error:
 * unknown` on the failure branch) into the wire-format data payload. Keeps
 * every phase/outcome discriminator intact and normalizes the error shape
 * so transports deliver machine-actionable failure metadata rather than a
 * stringified stack.
 */
export function encodeQuickEditResultForTransport(
  result: QuickEditResult,
): QuickEditResultData {
  const trace = {
    sessionId: result.sessionId,
    finalState: result.finalState,
    history: [...result.history],
    preflightResult: result.preflightResult,
    snapshotRef: result.snapshotRef,
    changedFiles: [...result.changedFiles],
    applyEdits: result.applyEdits
      ? {
          changedFiles: [...result.applyEdits.changedFiles],
          bytesWritten: result.applyEdits.bytesWritten,
          changeKindCounts: { ...result.applyEdits.changeKindCounts },
        }
      : null,
  };
  if (result.outcome === 'pass') {
    return {
      outcome: 'pass',
      auditResult: result.auditResult,
      ...trace,
    };
  }
  if (result.outcome === 'block') {
    if (result.phase === 'preflight') {
      return {
        outcome: 'block',
        phase: 'preflight',
        ...trace,
        preflightResult: result.preflightResult,
      };
    }
    return {
      outcome: 'block',
      phase: 'audit',
      ...trace,
      auditResult: result.auditResult,
      revertResult: result.revertResult,
      rollbackTemplate: result.rollbackTemplate,
    };
  }
  // result.outcome === 'failed'
  return {
    outcome: 'failed',
    phase: result.phase,
    error: normalizeQuickEditError(result.error),
    auditResult: result.auditResult,
    revertResult: result.revertResult,
    rollbackTemplate: result.rollbackTemplate,
    ...trace,
  };
}

type QuickEditFailureErrorPayload = Extract<
  QuickEditResultData,
  { outcome: 'failed' }
>['error'];

function normalizeQuickEditError(err: unknown): QuickEditFailureErrorPayload {
  if (err instanceof SessionError) {
    // `SessionErrorTransportDetails` in-process types `allowedStates` as
    // `readonly string[]` (narrower `SessionErrorDetails`), while the
    // shared schema infers the specific SessionState union. The runtime
    // values are identical, so we coerce through `unknown` to keep one
    // canonical details source without a parallel shape.
    const details = toSessionErrorTransportDetails(err) as unknown as
      QuickEditFailureErrorPayload['details'];
    return {
      class: 'SessionError',
      kind: err.kind,
      message: err.message,
      details,
    };
  }
  if (err instanceof Error) {
    const withKind = err as Error & { kind?: string };
    return {
      class: err.name || 'Error',
      kind: typeof withKind.kind === 'string' ? withKind.kind : (err.name || 'Error'),
      message: err.message || String(err),
      details: null,
    };
  }
  return {
    class: 'UnknownError',
    kind: 'unknown_error',
    message: typeof err === 'string' ? err : 'quickEdit phase threw non-Error value',
    details: null,
  };
}
