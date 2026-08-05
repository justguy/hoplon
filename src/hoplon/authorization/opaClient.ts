/**
 * authorization/opaClient.ts — typed seam for OPA decision evaluation
 * (T-145).
 *
 * Defines the `OpaClient` interface that `OpaAuthorizationAdapter`
 * consumes. The interface is intentionally minimal:
 *   - One method, `evaluate(decisionPath, input)`.
 *   - Returns a discriminated union (`{ kind: 'ok' } | { kind: 'error' }`)
 *     so transport-level failures are typed values, not exceptions.
 *   - Returns the OPA decision payload as `unknown` so the adapter must
 *     normalize through `normalizeOpaDecision` before any field access.
 *
 * Architecture rules:
 *   - No `fetch`, `node:http`, `node:net`, or environment reads here.
 *   - Pure interface. Implementations live outside this file (HTTP, gRPC,
 *     in-process embed, or tests).
 *   - No leaking of sidecar transport details into the deterministic
 *     kernel: errors carry a string `reason`, never raw error objects.
 *   - Named exports only. ES modules. No `any`.
 */

/** Result envelope returned by `OpaClient.evaluate`. */
export type OpaEvaluateResult =
  | { kind: 'ok'; raw: unknown }
  | { kind: 'error'; reason: string };

/**
 * Minimal OPA client contract. The caller passes the decision path
 * (e.g. `/v1/data/hoplon/authz/decision`) and the OPA input document;
 * the implementation handles transport, retries, and timeouts and
 * returns either a raw decision payload or a typed error.
 *
 * The `raw` field is `unknown` on purpose: the deterministic kernel
 * never reads OPA fields directly. All access goes through
 * `normalizeOpaDecision`, which validates shape and produces a typed
 * `HoplonAuthorizationDecision`.
 */
export interface OpaClient {
  evaluate(decisionPath: string, input: unknown): Promise<OpaEvaluateResult>;
}
