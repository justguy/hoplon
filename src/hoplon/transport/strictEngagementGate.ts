/**
 * transport/strictEngagementGate.ts — strict-agent access checks for t-096.
 *
 * Transport wrappers call this before dispatching strict read/search/edit
 * requests. It reuses the engagement lifecycle and policy-audit sink; it is
 * not a second access-control mechanism.
 */

import { canonicalizeProjectRelativeFolder } from '../concurrency/projectPolicy.js';
import type { AccessMode } from '../concurrency/projectPolicy.js';
import type { StrictEngagementContext } from '../contracts/engagementContext.js';
import type { EngagementStore } from '../launcher/engagementStore.js';
import type { VerifyExpectation, TokenVerification } from '../launcher/engagementLifecycle.js';
import {
  auditedVerifyEngagementToken,
  type GatedAction,
  type PolicyAuditSink,
} from './policyAuditSink.js';
import type {
  CapabilityGateDeps,
  CapabilityGateMode,
} from './capabilityEngagementGate.js';
import { runStrictCapabilityGate } from './strictCapabilityEnforcement.js';
import type { CapabilityKey } from '../authorization/capabilityGate.js';

export type StrictEngagementErrorKind =
  | 'engagement_gate_unavailable'
  | 'engagement_invalid_context'
  | 'engagement_missing_or_revoked'
  | 'engagement_expired'
  | 'engagement_scope_mismatch_project'
  | 'engagement_scope_mismatch_folder'
  | 'engagement_scope_mismatch_access'
  | 'engagement_scope_mismatch_principal'
  /** hcr-004: strict session record carries no recorded owner — fail closed. */
  | 'engagement_session_unowned';

export class StrictEngagementError extends Error {
  readonly kind: StrictEngagementErrorKind;
  readonly statusCode: number;
  readonly correlationId: string;

  constructor(args: {
    kind: StrictEngagementErrorKind;
    correlationId: string;
    statusCode: number;
  }) {
    super(`strict engagement error: ${args.kind}`);
    this.name = 'StrictEngagementError';
    this.kind = args.kind;
    this.statusCode = args.statusCode;
    this.correlationId = args.correlationId;
  }
}

export interface StrictEngagementGateDeps {
  readonly store?: EngagementStore;
  readonly sink?: PolicyAuditSink;
  readonly engineId: string;
  readonly clock?: () => Date;
  /**
   * T-147 capability gate (advisory-only; default OFF).
   *
   * When supplied AND `capability.mode === 'enforce'`, the capability
   * gate runs in PARALLEL after the legacy strict engagement gate
   * passes. Both gates must succeed for the operation to proceed. The
   * legacy gate result takes precedence on failure (T-142 verdict —
   * the capability gate cannot replace the strict engagement gate).
   *
   * Default: undefined / `mode: 'off'` → only the legacy gate runs.
   */
  readonly capability?: CapabilityGateDeps;
}

export interface StrictEngagementCheck {
  readonly engagement?: StrictEngagementContext;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly action: GatedAction;
  readonly requiredAccess: Exclude<AccessMode, 'none'>;
  readonly snapshotId?: string | null;
  /**
   * hcr-004 — expected engagement scope for the target resource (e.g. the
   * recorded owner of an edit session). When present, token verification
   * compares the presented token's binding against THIS scope instead of
   * the caller-presented context, so only the owner's engagement passes.
   * Additive; absent for non-resource-scoped checks.
   */
  readonly expectedScope?: {
    readonly folder: string;
    readonly principalId: string | null;
  };
  /**
   * T-147 capability-gate input. Populated by transport adapters when
   * the operation has resolved a target branch / path / AST scope. The
   * legacy gate ignores these fields; only the capability gate consumes
   * them. When `derivedCapability` is present this spec is treated as a
   * caller-described claim and validated against the derived facts
   * (hcr-004 finding 5); otherwise it is trusted as call-site-resolved.
   */
  readonly capability?: {
    readonly key: CapabilityKey;
    readonly branch: string;
    readonly path: string;
    readonly astNodeIds?: ReadonlyArray<string>;
    readonly astSelectors?: ReadonlyArray<string>;
    readonly sessionId?: string;
    readonly taskId?: string;
  };
  /**
   * hcr-004 finding 5 — capability facts derived server-side from the
   * actual operation (request targets, manifest paths, session state).
   * When the capability gate runs in `enforce` mode these facts — never
   * the caller-described `capability` spec — drive enforcement. `branch`
   * is '' when the transport cannot derive one (fail-closed for tokens
   * with constrained branch claims). Additive; existing callers that
   * only set `capability` keep the trusted call-site behavior.
   */
  readonly derivedCapability?: {
    readonly key: CapabilityKey;
    readonly branch: string;
    readonly paths: ReadonlyArray<string>;
    /** AST identities/selectors taken from the dispatched operation target. */
    readonly astNodeIds?: ReadonlyArray<string>;
    readonly astSelectors?: ReadonlyArray<string>;
    readonly sessionId?: string;
  };
}

export async function verifyStrictEngagementAccess(
  deps: StrictEngagementGateDeps,
  check: StrictEngagementCheck,
): Promise<void> {
  if (!deps.store || !deps.sink) {
    throw new StrictEngagementError({
      kind: 'engagement_gate_unavailable',
      correlationId: check.correlationId,
      statusCode: 503,
    });
  }

  const clock = deps.clock ?? (() => new Date());
  const expectation = buildExpectation(check, clock());
  const verification = await auditedVerifyEngagementToken({
    sink: deps.sink,
    store: deps.store,
    token: check.engagement?.token ?? '',
    expectation,
    action: check.action,
    context: {
      projectId: check.projectId,
      runId: check.runId,
      correlationId: check.correlationId,
      ...(check.snapshotId !== undefined ? { snapshotId: check.snapshotId } : {}),
    },
    clock,
  });

  if (verification.kind !== 'valid') {
    throw errorFromVerification(verification, check.correlationId);
  }

  // T-147 / hcr-004 — capability gate (runs after the legacy strict gate
  // has passed). In the default `off` mode behavior is unchanged: the
  // gate is a no-op. In the explicitly-enabled `enforce` mode the gate
  // fails closed: enforcement runs over server-derived facts (or minimal
  // synthetic facts when the call site supplied none), and any
  // caller-described capability spec is validated against the derived
  // facts instead of driving the decision. See
  // `strictCapabilityEnforcement.ts` for the composition rules.
  if (deps.capability) {
    await runStrictCapabilityGate(deps.capability, check);
  }
}

/**
 * Re-export the capability gate mode type so transport callers do not
 * need a second import for the opt-in flag.
 */
export type { CapabilityGateMode };

function buildExpectation(
  check: StrictEngagementCheck,
  now: Date,
): VerifyExpectation {
  // hcr-004: when the check targets an owned resource, the token binding
  // must match the resource's recorded scope — not merely whatever scope
  // the caller presented.
  const scope = check.expectedScope;
  if (check.engagement === undefined) {
    return {
      now,
      projectId: check.projectId,
      requiredAccess: check.requiredAccess,
      ...(scope !== undefined
        ? { folder: scope.folder, principalId: scope.principalId }
        : {}),
    };
  }
  const canonical = canonicalizeProjectRelativeFolder(check.engagement.folder);
  if (!canonical.ok || canonical.canonical !== check.engagement.folder) {
    throw new StrictEngagementError({
      kind: 'engagement_invalid_context',
      correlationId: check.correlationId,
      statusCode: 400,
    });
  }
  return {
    now,
    projectId: check.projectId,
    requiredAccess: check.requiredAccess,
    folder: scope !== undefined ? scope.folder : check.engagement.folder,
    principalId:
      scope !== undefined ? scope.principalId : check.engagement.principalId,
  };
}

function errorFromVerification(
  verification: Exclude<TokenVerification, { kind: 'valid' }>,
  correlationId: string,
): StrictEngagementError {
  if (verification.kind === 'missing') {
    return new StrictEngagementError({
      kind: 'engagement_missing_or_revoked',
      correlationId,
      statusCode: 401,
    });
  }
  if (verification.kind === 'expired') {
    return new StrictEngagementError({
      kind: 'engagement_expired',
      correlationId,
      statusCode: 401,
    });
  }
  return new StrictEngagementError({
    kind: strictMismatchKind(verification.reason),
    correlationId,
    statusCode: 403,
  });
}

function strictMismatchKind(
  reason: Extract<TokenVerification, { kind: 'scope_mismatch' }>['reason'],
): StrictEngagementErrorKind {
  switch (reason) {
    case 'project_id':
      return 'engagement_scope_mismatch_project';
    case 'folder':
      return 'engagement_scope_mismatch_folder';
    case 'access':
      return 'engagement_scope_mismatch_access';
    case 'principal':
      return 'engagement_scope_mismatch_principal';
  }
}
