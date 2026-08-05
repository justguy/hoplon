/**
 * authorization/policyBundle/bundledOpaClient.ts — `OpaClient`
 * implementation backed by the in-process policy evaluator (T-149).
 *
 * STATUS: ADVISORY / TEST/FIXTURE-ONLY. NOT FOR PRODUCTION USE.
 *
 *   This client is a hermetic stand-in for a real OPA sidecar. It lets the
 *   deterministic kernel and corpus tests exercise
 *   `OpaAuthorizationAdapter` against the documented policy semantics
 *   without spawning OPA. Production deployments wire a real HTTP/gRPC
 *   `OpaClient` against an OPA sidecar (see `policy/README.md`).
 *
 *   The constructor name is intentionally explicit: `BundledOpaClient`
 *   advertises that it is the in-process bundle, not a sidecar
 *   transport. Callers wiring a default runtime adapter must NOT pick
 *   this client.
 *
 * Architecture rules:
 *   - Pure (modulo the injected `decisionId` source). No HTTP, fs, env,
 *     or clock reads.
 *   - Failure is exposed via injectable `forceError` / explicit `mode`,
 *     so fail-closed adapter behavior can be tested deterministically.
 *   - Named exports only. TypeScript strict. No `any`.
 */
import type { OpaClient, OpaEvaluateResult } from '../opaClient.js';
import {
  evaluatePolicyBundle,
  type BundleOpaInput,
  type EvaluatorDeps,
} from './evaluator.js';
import type { PolicyData } from './types.js';

/** Configurable construction surface for `BundledOpaClient`. */
export type BundledOpaClientDeps = {
  /** The parsed policy data document. */
  readonly policy: PolicyData;
  /**
   * Generates the `decisionId` field embedded in every emitted decision.
   * Tests usually supply a deterministic counter; production-equivalent
   * code would use a UUID generator.
   */
  readonly generateDecisionId: () => string;
  /**
   * If set to `'unavailable'`, every `evaluate` call returns
   * `{ kind: 'error', reason }` so the adapter's fail-closed path can be
   * exercised without monkey-patching the network. Reset to `'live'` to
   * resume normal evaluation.
   */
  readonly mode?: 'live' | 'unavailable';
  /**
   * Reason string surfaced when `mode === 'unavailable'`.
   * Defaults to `'sidecar_unavailable'`.
   */
  readonly unavailableReason?: string;
  /**
   * Optional decision-payload override hook. Receives the raw decision
   * the evaluator produced and returns the payload that
   * `OpaClient.evaluate` will return. Used in tests to force malformed
   * responses (e.g. drop a required field).
   */
  readonly transformDecision?: (
    decision: Record<string, unknown>,
  ) => unknown;
};

/**
 * `OpaClient` implementation that routes through the in-process
 * `evaluatePolicyBundle`. Test/fixture-only: never use this client to
 * mint production tokens.
 */
export class BundledOpaClient implements OpaClient {
  private readonly policy: PolicyData;
  private readonly generateDecisionId: () => string;
  private mode: 'live' | 'unavailable';
  private readonly unavailableReason: string;
  private readonly transformDecision: BundledOpaClientDeps['transformDecision'];

  constructor(deps: BundledOpaClientDeps) {
    this.policy = deps.policy;
    this.generateDecisionId = deps.generateDecisionId;
    this.mode = deps.mode ?? 'live';
    this.unavailableReason = deps.unavailableReason ?? 'sidecar_unavailable';
    this.transformDecision = deps.transformDecision;
  }

  /**
   * Switch the client into `'unavailable'` mode at runtime so tests can
   * exercise fail-closed behavior without recreating the client.
   */
  setMode(mode: 'live' | 'unavailable'): void {
    this.mode = mode;
  }

  /** Current mode. Exposed for assertions in tests. */
  get currentMode(): 'live' | 'unavailable' {
    return this.mode;
  }

  /**
   * Evaluate a bundled-OPA decision.
   *
   * The contract matches the production `OpaClient.evaluate`:
   *   - `decisionPath` is accepted but not used in routing — the
   *     in-process bundle exposes a single decision endpoint. Tests may
   *     assert the adapter passed `DEFAULT_OPA_DECISION_PATH`.
   *   - `input` is treated as `BundleOpaInput`. Shape mismatch surfaces
   *     as a malformed adapter response (the evaluator returns a
   *     decision; if shape is broken `normalizeOpaDecision` rejects).
   */
  async evaluate(
    decisionPath: string,
    input: unknown,
  ): Promise<OpaEvaluateResult> {
    if (this.mode === 'unavailable') {
      return { kind: 'error', reason: this.unavailableReason };
    }
    if (!isBundleInput(input)) {
      return {
        kind: 'error',
        reason: `bundle_input_malformed: not a bundle-shaped object (decisionPath=${decisionPath})`,
      };
    }
    const deps: EvaluatorDeps = {
      generateDecisionId: this.generateDecisionId,
    };
    const decision = evaluatePolicyBundle(this.policy, input, deps);
    const raw = this.transformDecision !== undefined
      ? this.transformDecision(decision)
      : decision;
    return { kind: 'ok', raw };
  }
}

function isBundleInput(input: unknown): input is BundleOpaInput {
  if (input === null || typeof input !== 'object' || Array.isArray(input)) return false;
  const obj = input as Record<string, unknown>;
  if (obj['principal'] === undefined || obj['task'] === undefined) return false;
  if (obj['request'] === undefined || obj['context'] === undefined) return false;
  if (!Array.isArray(obj['activeGrants'])) return false;
  return true;
}
