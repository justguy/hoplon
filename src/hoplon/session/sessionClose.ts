import { clearOverlay } from './sessionOverlay.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { advanceSession } from './sessionStateMethods.js';

export function closeSession(runtime: SessionRuntime): void {
  if (runtime.state === 'closed') return;
  runtime.stagingStore.dispose();
  void clearOverlay(runtime).catch(() => undefined);
  const priorState = runtime.state;
  advanceSession(runtime, 'close', 'closed');
  const finalStatus =
    priorState === 'audited_pass' ? 'PASS'
    : priorState === 'audited_block' ? 'BLOCK'
    : priorState === 'rollback_extracted' || priorState === 'reverted' ? 'BLOCK'
    : 'CLOSED';
  runtime.sessionTelemetry.emitSessionEnd(
    Math.max(0, runtime.now() - runtime.sessionStartedAtMs),
    finalStatus === 'BLOCK' ? 'BLOCK' : 'PASS',
  );
  void runtime.traceWriter.closeExecution(
    finalStatus,
    new Date(runtime.now()).toISOString(),
  );
}
