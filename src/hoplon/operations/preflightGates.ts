import type { AuditViolation } from '../contracts/audit.js';
import type { PreflightGateResult, PreflightResult } from '../contracts/preflight.js';
import type { PreflightRequest } from '../contracts/requests.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import type { PreflightGate, PreflightGateContext } from './preflight.js';

/** Compose the overall preflight result while preserving gate order. */
export function aggregatePreflightResult(
  gateResults: PreflightGateResult[],
  correlationId: string,
): PreflightResult {
  const anyBlock = gateResults.some((gate) => gate.status === 'BLOCK');
  return {
    status: anyBlock ? 'BLOCK' : 'PASS',
    gates: gateResults,
    correlationId,
  };
}

/** Convert path-traversal validation failures into structured violations. */
export const pathTraversalGate: PreflightGate = {
  name: 'path_traversal',

  async run(
    req: PreflightRequest,
    ctx: PreflightGateContext,
    _signal?: AbortSignal,
  ): Promise<PreflightGateResult> {
    const startedAt = Date.now();
    const violations: AuditViolation[] = [];

    for (const entry of req.manifest.entries) {
      try {
        canonicalizePath({
          path: entry.path,
          root: ctx.config.fsRoot,
          engineId: ctx.engineId,
          correlationId: req.correlationId,
        });
      } catch (err) {
        if (err instanceof ValidationError && err.kind === 'path_traversal') {
          violations.push({
            kind: 'PATH_ESCAPE',
            path: entry.path,
            resolvedPath: '<redacted>',
            sandboxRoot: ctx.config.fsRoot,
            message: `Path "${entry.path}" escapes the sandbox root.`,
            correction: 'Remove the entry or correct the path to stay within the contracted sandbox.',
          });
        } else {
          throw err;
        }
      }
    }

    return {
      gateName: 'path_traversal',
      status: violations.length === 0 ? 'PASS' : 'BLOCK',
      violations,
      durationMs: Date.now() - startedAt,
    };
  },
};
