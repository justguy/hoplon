/**
 * transport/strictCapabilityEnforcement.ts — capability-gate composition
 * for the strict engagement gate (T-147 + hcr-004 finding 5).
 *
 * Extracted from `strictEngagementGate.ts` so the gate file stays under
 * the 300-line architecture cap. One entry point: `runStrictCapabilityGate`,
 * called by `verifyStrictEngagementAccess` AFTER the legacy strict gate
 * has passed.
 *
 * Modes:
 *   - `off` (default): unchanged legacy behavior — the gate is a no-op
 *     (a caller-supplied spec is still routed through
 *     `verifyCapabilityAccess`, which returns immediately in `off` mode).
 *   - `enforce` (explicit host opt-in): fail closed. Enforcement runs
 *     over server-derived facts (`derivedCapability`) — or minimal
 *     synthetic facts when the call site supplied none — and any
 *     caller-described `capability` spec is validated against the
 *     derived facts instead of driving the decision.
 */

import type {
  CapabilityDeniedReason,
  CapabilityKey,
} from '../authorization/capabilityGate.js';
import {
  CapabilityDeniedError,
  DEFAULT_CAPABILITY_GATE_MODE,
  verifyCapabilityAccess,
  type CapabilityCheck,
  type CapabilityGateDeps,
} from './capabilityEngagementGate.js';
import type { GatedAction } from './policyAuditSink.js';
import type { StrictEngagementCheck } from './strictEngagementGate.js';

export async function runStrictCapabilityGate(
  gate: CapabilityGateDeps,
  check: StrictEngagementCheck,
): Promise<void> {
  const mode = gate.mode ?? DEFAULT_CAPABILITY_GATE_MODE;
  if (mode !== 'enforce') {
    // `off`: preserved legacy path — `verifyCapabilityAccess` no-ops.
    if (check.capability) {
      await verifyCapabilityAccess(
        gate,
        callSiteCapabilityCheck(check, check.capability),
      );
    }
    return;
  }
  if (check.derivedCapability !== undefined) {
    const derived = await resolveDerivedCapability(gate, check);
    if (check.capability) {
      assertDeclaredCapabilityMatchesDerived(
        check.capability,
        derived,
        check.correlationId,
      );
    }
    await enforceDerivedCapability(gate, check, derived);
    return;
  }
  if (check.capability) {
    // Call-site-resolved spec (trusted server code, T-147 posture).
    await verifyCapabilityAccess(
      gate,
      callSiteCapabilityCheck(check, check.capability),
    );
    return;
  }
  // Fail closed: neither derived facts nor a call-site spec. Enforce
  // against minimal derived facts (no branch, no path) — only tokens
  // whose claims are genuinely unconstrained can pass.
  await enforceDerivedCapability(gate, check, {
    key: capabilityKeyForAction(check.action),
    branch: '',
    paths: [],
  });
}

function callSiteCapabilityCheck(
  check: StrictEngagementCheck,
  spec: NonNullable<StrictEngagementCheck['capability']>,
): CapabilityCheck {
  return {
    ...(check.engagement !== undefined ? { engagement: check.engagement } : {}),
    correlationId: check.correlationId,
    capability: spec.key,
    projectId: check.projectId,
    branch: spec.branch,
    path: spec.path,
    ...(spec.astNodeIds !== undefined ? { astNodeIds: spec.astNodeIds } : {}),
    ...(spec.astSelectors !== undefined
      ? { astSelectors: spec.astSelectors }
      : {}),
    ...(spec.sessionId !== undefined ? { sessionId: spec.sessionId } : {}),
    ...(spec.taskId !== undefined ? { taskId: spec.taskId } : {}),
  };
}

/**
 * Run the capability check over the server-derived facts, one check per
 * derived target path (a single '' path when no path is derivable, which
 * `assertCapability` fail-closes for path-constrained tokens). Only AST facts
 * derived from the dispatched target are forwarded. Caller-declared AST/task
 * fields never drive enforcement.
 */
async function enforceDerivedCapability(
  gate: CapabilityGateDeps,
  check: StrictEngagementCheck,
  derived: NonNullable<StrictEngagementCheck['derivedCapability']>,
): Promise<void> {
  const paths = derived.paths.length > 0 ? derived.paths : [''];
  for (const path of paths) {
    await verifyCapabilityAccess(gate, {
      ...(check.engagement !== undefined ? { engagement: check.engagement } : {}),
      correlationId: check.correlationId,
      capability: derived.key,
      projectId: check.projectId,
      branch: derived.branch,
      path,
      ...(derived.astNodeIds !== undefined
        ? { astNodeIds: derived.astNodeIds }
        : {}),
      ...(derived.astSelectors !== undefined
        ? { astSelectors: derived.astSelectors }
        : {}),
      ...(derived.sessionId !== undefined ? { sessionId: derived.sessionId } : {}),
    });
  }
}

async function resolveDerivedCapability(
  gate: CapabilityGateDeps,
  check: StrictEngagementCheck,
): Promise<NonNullable<StrictEngagementCheck['derivedCapability']>> {
  const derived = check.derivedCapability!;
  let branch = '';
  if (gate.resolveBranch !== undefined) {
    try {
      const resolved = await gate.resolveBranch({
        projectId: check.projectId,
        runId: check.runId,
      });
      if (typeof resolved === 'string' && resolved.length > 0) branch = resolved;
    } catch {
      // Resolver failure is authorization-unavailable, not permission. The
      // empty branch preserves the existing fail-closed gate outcome.
    }
  }
  return { ...derived, branch };
}

/**
 * hcr-004 finding 5 — a caller-described capability spec must agree with
 * the facts derived from the actual operation. When the server branch
 * resolver succeeds, branch lies are typed policy denials alongside key,
 * path, AST, and session lies. Reason
 * codes reuse the closed `CapabilityDeniedReason` union: a key mismatch
 * maps to `capability_missing` (the declared capability does not describe
 * this operation).
 */
function assertDeclaredCapabilityMatchesDerived(
  declared: NonNullable<StrictEngagementCheck['capability']>,
  derived: NonNullable<StrictEngagementCheck['derivedCapability']>,
  correlationId: string,
): void {
  if (declared.key !== derived.key) {
    throw declaredSpecDenied('capability_missing', declared, correlationId, declared.key);
  }
  if (derived.paths.length > 0 && !derived.paths.includes(declared.path)) {
    throw declaredSpecDenied('path_mismatch', declared, correlationId, declared.path);
  }
  if (derived.branch.length > 0 && declared.branch !== derived.branch) {
    throw declaredSpecDenied(
      'branch_mismatch',
      declared,
      correlationId,
      declared.branch,
    );
  }
  if (
    declared.astNodeIds !== undefined &&
    !sameStrings(declared.astNodeIds, derived.astNodeIds)
  ) {
    throw declaredSpecDenied('ast_mismatch', declared, correlationId);
  }
  if (
    declared.astSelectors !== undefined &&
    !sameStrings(declared.astSelectors, derived.astSelectors)
  ) {
    throw declaredSpecDenied('ast_mismatch', declared, correlationId);
  }
  if (
    derived.sessionId !== undefined &&
    declared.sessionId !== undefined &&
    declared.sessionId !== derived.sessionId
  ) {
    throw declaredSpecDenied('session_mismatch', declared, correlationId);
  }
}

function sameStrings(
  declared: ReadonlyArray<string>,
  derived: ReadonlyArray<string> | undefined,
): boolean {
  return (
    derived !== undefined &&
    declared.length === derived.length &&
    declared.every((value, index) => value === derived[index])
  );
}

function declaredSpecDenied(
  reason: CapabilityDeniedReason,
  declared: NonNullable<StrictEngagementCheck['capability']>,
  correlationId: string,
  field?: string,
): CapabilityDeniedError {
  return new CapabilityDeniedError({
    kind: 'policy_denied',
    reason,
    statusCode: 403,
    correlationId,
    decisionId: null,
    policyVersion: null,
    tokenId: null,
    capability: declared.key,
    branch: declared.branch,
    path: declared.path,
    ...(field !== undefined ? { field } : {}),
  });
}

function capabilityKeyForAction(action: GatedAction): CapabilityKey {
  if (action === 'search') return 'search';
  if (action === 'edit') return 'write';
  return 'read';
}
