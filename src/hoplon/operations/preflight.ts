/**
 * operations/preflight.ts — PR1 preflight() umbrella operation.
 *
 * preflight() is a composable gate registry. Stage 1 pre-execution checks
 * (path-traversal validation, LC1 checkTargets in Phase 2 Stage B, etc.) are
 * implemented as PreflightGate instances and registered in the factory's
 * PreflightDeps.gates array. Each gate runs in order; the aggregated result is
 * returned as a structured PreflightResult — not thrown.
 *
 * ## Gate contract
 * Gates return structured violations (PreflightGateResult) rather than throwing
 * for expected validation failures. Only unexpected errors (EngineError,
 * AdapterError, etc.) propagate as thrown exceptions — the preflight() operation
 * catches those, emits 'error', and re-throws.
 *
 * ## Path traversal gate
 * Phase 2 PR1 ships with ONE default gate: pathTraversalGate. This gate moves
 * H9 enforcement into the gate framework (previously inline in each operation).
 * The gate catches ValidationError { kind: 'path_traversal' } from canonicalizePath
 * and converts it to a PATH_ESCAPE AuditViolation. This conversion is intentional
 * — in the gate framework, violations are structured payload, not exceptions.
 * Other errors from canonicalizePath (unexpected errors) are re-thrown as-is.
 *
 * ## H9 defense-in-depth decision
 * Existing operations (createSnapshot, auditDiff, dryRun) still perform their own
 * inline path canonicalization. PR1 does NOT refactor those — it establishes the
 * gate framework as the new canonical pre-execution check point. Phase 2 LC* gates
 * will register as additional gates in the factory's gates array.
 *
 * ## Future extension (Phase 2 Stage B LC1)
 * LC1 (checkTargets) will add a second gate in factory.ts:
 *   gates: [pathTraversalGate, checkTargetsGate]
 * No API change required — only a new gate entry in PreflightDeps.
 *
 * ## H11 / H13 event discipline
 * Emits 'preflight' op:
 *   - 'start' event before any gates run
 *   - 'end' event with classification: 'PASS' | 'BLOCK' on success
 *   - 'error' event on thrown EngineError / AdapterError / unexpected errors
 * No content (paths, manifest entries, violations) flows into HoplonEvent.
 *
 * ## Import wall
 * Imports only from ../adapters/*, ../contracts/*, ../util/*.
 * Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { PreflightGateResult, PreflightResult } from '../contracts/preflight.js';
import type { PreflightRequest } from '../contracts/requests.js';
import { runPreflight } from './preflightExecution.js';

export { aggregatePreflightResult, pathTraversalGate } from './preflightGates.js';

// ---------------------------------------------------------------------------
// Gate context — what each gate receives
// ---------------------------------------------------------------------------

/**
 * The context passed to each PreflightGate.run() call.
 * Provides access to all adapters and frozen engine config.
 */
export interface PreflightGateContext {
  /** Filesystem adapter (C2). */
  fs: HoplonFsAdapter;
  /** VersioningAdapter (C4). */
  versioning: VersioningAdapter;
  /** SQLite snapshot store (C1). */
  snapshotStore: SnapshotStore;
  /** Code intelligence adapter (D3). */
  codeIntelligence: CodeIntelligenceAdapter;
  /** Operational event emitter (C5). */
  emitter: HoplonEmitter;
  /** Engine identity (H5). */
  engineId: string;
  config: {
    /**
     * Trusted filesystem root. All manifest entry paths are canonicalized
     * against this. For memfs tests pass '/'; for production pass project root.
     */
    fsRoot: string;
    /**
     * Path to the Hoplon-internal git repository.
     * Required by checkTargetsGate (LC1) for versioning.readBlob calls.
     * Optional here: gates that do not need git access may ignore this field.
     * Defaults to '.hoplon/repo' when absent in the factory.
     */
    gitRepoDir?: string;
  };
}

// ---------------------------------------------------------------------------
// PreflightGate — pluggable validator interface
// ---------------------------------------------------------------------------

/**
 * A single named validation gate registered in the preflight engine.
 *
 * Gates produce structured PreflightGateResult values — they do NOT throw for
 * expected validation failures (those become violations). Only unexpected errors
 * (EngineError, AdapterError) are thrown; preflight() propagates those.
 *
 * ## Gate registration order
 * Gates run in the order they appear in PreflightDeps.gates[]. The aggregated
 * PreflightResult.gates[] preserves that order. Future gates can depend on prior
 * gate results if needed (they receive the full req and ctx).
 *
 * ## Naming convention
 * Gate names use snake_case, e.g. 'path_traversal', 'check_targets'.
 */
export interface PreflightGate {
  /** Stable identifier — used in PreflightGateResult.gateName. */
  name: string;
  /**
   * Run this gate against the request.
   *
   * @param req  — the full preflight request (manifest + identity fields)
   * @param ctx  — adapter context injected by the engine
   * @param signal — optional AbortSignal (H12)
   * @returns PreflightGateResult — always returns; never throws for validation failures
   * @throws {EngineError | AdapterError} — unexpected infrastructure failures only
   */
  run(
    req: PreflightRequest,
    ctx: PreflightGateContext,
    signal?: AbortSignal,
  ): Promise<PreflightGateResult>;
}

// ---------------------------------------------------------------------------
// PreflightDeps — injected dependencies + gate registry
// ---------------------------------------------------------------------------

/**
 * Dependencies for preflight(). Extends PreflightGateContext with:
 *   - gates: the registered gate array (order-preserving)
 *
 * Phase 2 PR1 factory wires: gates: [pathTraversalGate]
 * Phase 2 Stage B LC1 will add: gates: [pathTraversalGate, checkTargetsGate]
 */
export interface PreflightDeps extends PreflightGateContext {
  /** Registered gates. Run in array order. */
  gates: PreflightGate[];
}

// ---------------------------------------------------------------------------
// preflight — main entry point
// ---------------------------------------------------------------------------

/**
 * Run all registered preflight gates against the provided request.
 *
 * Returns PreflightResult with per-gate status and aggregated overall status.
 * Validation failures are structured violations; infrastructure errors throw.
 *
 * ## AbortSignal (H12)
 * Checked at entry (before any work). Also checked before each gate runs.
 * Per-gate run() receives the signal for optional internal abort support.
 *
 * ## Emit discipline (H11, H13)
 * - 'start' before gates run
 * - 'end' with classification after all gates complete
 * - 'error' on any thrown exception (EngineError, AdapterError, abort, etc.)
 * No content in events (no manifest paths, no violation details).
 *
 * @throws {ValidationError}  kind 'invalid_manifest' — Zod parse failure
 * @throws {ValidationError}  kind 'invalid_correlation_id' — bad correlationId
 * @throws {ValidationError}  kind 'invalid_run_id' — bad runId
 * @throws {DOMException}     name 'AbortError' — signal pre-aborted or aborted mid-run
 * @throws {EngineError | AdapterError | SemanticError} — from gate infrastructure failures
 */
export async function preflight(
  deps: PreflightDeps,
  req: PreflightRequest,
  signal?: AbortSignal,
): Promise<PreflightResult> {
  return runPreflight(deps, req, signal);
}
