import type { HoplonEmitter, HoplonEvent } from '../adapters/emitter.js';

type OperationKind = NonNullable<HoplonEvent['operationKind']>;
type Classification = NonNullable<HoplonEvent['classification']>;

export type SessionTelemetryDetails = Partial<
  Pick<
    HoplonEvent,
    | 'classification'
    | 'durationMs'
    | 'errorCategory'
    | 'errorKind'
    | 'inputCount'
    | 'outputCount'
    | 'resultCount'
    | 'fileCount'
    | 'changedFileCount'
    | 'subjectCount'
    | 'documentCount'
    | 'violationCount'
    | 'byteCount'
    | 'attemptCount'
  >
>;

export interface SessionTelemetry {
  emitSessionStart(): void;
  emitSessionEnd(durationMs: number, classification: Classification): void;
  observeAsync<T>(
    base: SessionTelemetryBase,
    run: () => Promise<T>,
    details?: (result: T) => SessionTelemetryDetails,
  ): Promise<T>;
  observeSync<T>(
    base: SessionTelemetryBase,
    run: () => T,
    details?: (result: T) => SessionTelemetryDetails,
  ): T;
}

export interface SessionTelemetryBase extends SessionTelemetryDetails {
  op: HoplonEvent['op'];
  operationKind: OperationKind;
}

export interface CreateSessionTelemetryOptions {
  emitter: HoplonEmitter | null;
  getEngineId: () => string;
  projectId: string;
  runId: string;
  correlationId: string;
  now: () => number;
}

export function createSessionTelemetry(
  opts: CreateSessionTelemetryOptions,
): SessionTelemetry {
  function emit(base: SessionTelemetryBase, phase: HoplonEvent['phase']): void {
    if (opts.emitter === null) return;
    try {
      opts.emitter.emit({
        engineId: opts.getEngineId(),
        projectId: opts.projectId,
        runId: opts.runId,
        correlationId: opts.correlationId,
        phase,
        ...base,
      });
    } catch {
      // Emitter failures are observability-only.
    }
  }

  function emitTerminal(
    base: SessionTelemetryBase,
    phase: 'end' | 'error',
    startedAtMs: number,
    details?: SessionTelemetryDetails,
    err?: unknown,
  ): void {
    emit(
      {
        ...base,
        durationMs: Math.max(0, opts.now() - startedAtMs),
        ...(phase === 'error'
          ? {
              classification: 'ERROR',
              errorCategory: 'validation',
              errorKind: errorKind(err),
            }
          : {}),
        ...(details ?? {}),
      },
      phase,
    );
  }

  return {
    emitSessionStart() {
      emit({ op: 'session', operationKind: 'session' }, 'start');
    },
    emitSessionEnd(durationMs, classification) {
      emit({ op: 'session', operationKind: 'session', durationMs, classification }, 'end');
    },
    async observeAsync(base, run, details) {
      const startedAtMs = opts.now();
      emit(base, 'start');
      try {
        const result = await run();
        emitTerminal(base, 'end', startedAtMs, details?.(result));
        return result;
      } catch (err) {
        emitTerminal(base, 'error', startedAtMs, undefined, err);
        throw err;
      }
    },
    observeSync(base, run, details) {
      const startedAtMs = opts.now();
      emit(base, 'start');
      try {
        const result = run();
        emitTerminal(base, 'end', startedAtMs, details?.(result));
        return result;
      } catch (err) {
        emitTerminal(base, 'error', startedAtMs, undefined, err);
        throw err;
      }
    },
  };
}

function errorKind(err: unknown): string {
  if (err !== null && typeof err === 'object' && 'kind' in err) {
    const kind = (err as { kind?: unknown }).kind;
    if (typeof kind === 'string' && kind.length > 0) return kind;
  }
  if (err instanceof Error && err.name.length > 0) return err.name;
  return 'session_error';
}
