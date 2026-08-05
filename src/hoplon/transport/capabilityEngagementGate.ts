/**
 * transport/capabilityEngagementGate.ts — capability gate adapter at
 * the HTTP / MCP transport entry boundary (T-147 + t-148 audit hook).
 *
 * Advisory-only by default; runs in parallel with the legacy strict
 * engagement gate when the transport opts in via `mode: 'enforce'`.
 *
 * The gate does not call OPA. It resolves the `CapabilityEngagementToken`
 * via the injected `CapabilityClaimsStore`, runs the pure `assertCapability`
 * core, and (when `auditSink` + `auditContext` are wired) emits one
 * `POLICY_CAPABILITY_CHECK` row per outcome. Audit-write failures NEVER
 * change the gate decision.
 */

import type { CapabilityClaimsStore } from '../authorization/capabilityClaimsStore.js';
import type { StrictEngagementContext } from '../contracts/engagementContext.js';
import {
  assertCapability,
  type CapabilityAssertionResult,
  type CapabilityKey,
  type CapabilityOpSpec,
  type CapabilityDeniedReason,
} from '../authorization/capabilityGate.js';
import { enforceCapabilityRuntimeState } from '../authorization/capabilityRuntimeState.js';
import type {
  CapabilityEngagementToken,
} from '../authorization/capabilityToken.js';
import type {
  CapabilityCheckOutcome,
  PolicyAuditContext,
  PolicyAuditSink,
} from './policyAuditSink.js';

/**
 * Mode flag for the capability gate. Default is `off` — the gate is
 * advisory and only runs when the transport explicitly opts in.
 */
export type CapabilityGateMode = 'enforce' | 'off';

/** Default value used when the transport does not configure the gate. */
export const DEFAULT_CAPABILITY_GATE_MODE: CapabilityGateMode = 'off';

/**
 * Typed error envelope thrown when the capability gate denies an
 * operation. Carries the audit-ready fields T-148 will persist.
 */
export class CapabilityDeniedError extends Error {
  /**
   * `policy_denied` for hard denies; `reauth_required` for fail-closed
   * cases the agent can recover from by re-running handshake.
   */
  readonly kind: 'policy_denied' | 'reauth_required';
  readonly reason: CapabilityDeniedReason;
  readonly statusCode: number;
  readonly correlationId: string;
  /** Audit evidence — populated for T-148 consumption. */
  readonly decisionId: string | null;
  readonly policyVersion: string | null;
  readonly tokenId: string | null;
  readonly capability: CapabilityKey;
  readonly branch: string;
  readonly path: string;
  readonly field?: string;

  constructor(args: {
    kind: 'policy_denied' | 'reauth_required';
    reason: CapabilityDeniedReason;
    statusCode: number;
    correlationId: string;
    decisionId: string | null;
    policyVersion: string | null;
    tokenId: string | null;
    capability: CapabilityKey;
    branch: string;
    path: string;
    field?: string;
  }) {
    super(`capability gate ${args.kind}: ${args.reason}`);
    this.name = 'CapabilityDeniedError';
    this.kind = args.kind;
    this.reason = args.reason;
    this.statusCode = args.statusCode;
    this.correlationId = args.correlationId;
    this.decisionId = args.decisionId;
    this.policyVersion = args.policyVersion;
    this.tokenId = args.tokenId;
    this.capability = args.capability;
    this.branch = args.branch;
    this.path = args.path;
    if (args.field !== undefined) this.field = args.field;
  }
}

/** Gate dependencies. Optional t-148 audit writes never change the decision. */
export interface CapabilityGateDeps {
  readonly claimsStore?: CapabilityClaimsStore;
  readonly mode?: CapabilityGateMode;
  readonly clock?: () => Date;
  /** Server-owned only; missing/empty/failure preserves fail-closed branch. */
  readonly resolveBranch?: (scope: {
    readonly projectId: string;
    readonly runId: string;
  }) => string | null | undefined | Promise<string | null | undefined>;
  /** t-148 — audit sink for capability-gate outcomes. */
  readonly auditSink?: PolicyAuditSink;
  /** t-148 — audit context for the emitted row. */
  readonly auditContext?: PolicyAuditContext;
}

/**
 * Per-request input to `verifyCapabilityAccess`. Mirrors the legacy
 * `StrictEngagementCheck` shape for the fields the gate needs.
 */
export interface CapabilityCheck {
  readonly engagement?: StrictEngagementContext;
  readonly correlationId: string;
  readonly capability: CapabilityKey;
  readonly projectId: string;
  readonly branch: string;
  readonly path: string;
  readonly astNodeIds?: ReadonlyArray<string>;
  readonly astSelectors?: ReadonlyArray<string>;
  readonly sessionId?: string;
  readonly taskId?: string;
}

/**
 * Run the capability gate. No-op when the gate is in `off` mode (the
 * default — the legacy strict engagement gate is the sole access check
 * unless the caller explicitly opts in).
 *
 * Failure modes (when enforce):
 *   - No claims store wired → `policy_denied` (`invalid_token`).
 *     Defense-in-depth: enforce mode without a store is a configuration
 *     bug; we fail closed.
 *   - No engagement context on the request → `reauth_required`
 *     (`invalid_token`). The handshake must have minted a capability
 *     token first.
 *   - Token not in claims store → `reauth_required` (`invalid_token`).
 *   - Otherwise, delegate to `assertCapability`.
 */
export async function verifyCapabilityAccess(
  deps: CapabilityGateDeps,
  check: CapabilityCheck,
): Promise<void> {
  const mode = deps.mode ?? DEFAULT_CAPABILITY_GATE_MODE;
  if (mode === 'off') return;

  const startMs = (deps.clock ?? (() => new Date()))().getTime();
  const claimsStore = deps.claimsStore;
  if (!claimsStore) {
    const assertion: CapabilityAssertionResult = {
      kind: 'denied',
      reason: 'invalid_token',
    };
    await emitCapabilityAuditRow(deps, check, assertion, null, startMs);
    throw buildDenied('policy_denied', 503, 'invalid_token', check, null);
  }

  const tokenString = check.engagement?.token ?? '';
  if (tokenString.length === 0) {
    const assertion: CapabilityAssertionResult = {
      kind: 'reauth_required',
      reason: 'invalid_token',
    };
    await emitCapabilityAuditRow(deps, check, assertion, null, startMs);
    throw buildDenied('reauth_required', 401, 'invalid_token', check, null);
  }
  const token = claimsStore.get(tokenString);
  if (!token) {
    const assertion: CapabilityAssertionResult = {
      kind: 'reauth_required',
      reason: 'invalid_token',
    };
    await emitCapabilityAuditRow(deps, check, assertion, null, startMs);
    throw buildDenied('reauth_required', 401, 'invalid_token', check, null);
  }

  const clock = deps.clock ?? (() => new Date());
  const op: CapabilityOpSpec = {
    capability: check.capability,
    projectId: check.projectId,
    branch: check.branch,
    path: check.path,
    ...(check.astNodeIds !== undefined ? { astNodeIds: check.astNodeIds } : {}),
    ...(check.astSelectors !== undefined
      ? { astSelectors: check.astSelectors }
      : {}),
    ...(check.sessionId !== undefined ? { sessionId: check.sessionId } : {}),
    ...(check.taskId !== undefined ? { taskId: check.taskId } : {}),
    ...(check.engagement?.principalId !== undefined &&
    check.engagement.principalId !== null
      ? { principalId: check.engagement.principalId }
      : {}),
  };

  let result: CapabilityAssertionResult = assertCapability({
    token,
    op,
    clock,
  });
  if (result.kind === 'ok') {
    result = enforceCapabilityRuntimeState({
      claimsStore,
      tokenString,
      token,
      op,
    });
  }

  await emitCapabilityAuditRow(deps, check, result, token, startMs);

  if (result.kind === 'ok') return;

  const status = statusCodeFor(result.kind);
  throw new CapabilityDeniedError({
    kind: result.kind === 'denied' ? 'policy_denied' : 'reauth_required',
    reason: result.reason,
    statusCode: status,
    correlationId: check.correlationId,
    decisionId: token.policy?.decisionId ?? null,
    policyVersion: token.policy?.policyVersion ?? null,
    tokenId: token.tokenId,
    capability: check.capability,
    branch: check.branch,
    path: check.path,
    ...(result.field !== undefined ? { field: result.field } : {}),
  });
}

/**
 * Emit one `POLICY_CAPABILITY_CHECK` row when both `auditSink` and
 * `auditContext` are wired. Audit-write failures are swallowed — the
 * gate decision must NEVER change because of an audit-sink throw.
 */
async function emitCapabilityAuditRow(
  deps: CapabilityGateDeps,
  check: CapabilityCheck,
  assertion: CapabilityAssertionResult,
  token: CapabilityEngagementToken | null,
  startMs: number,
): Promise<void> {
  const sink = deps.auditSink;
  const context = deps.auditContext;
  if (!sink || !context) return;
  const clock = deps.clock ?? (() => new Date());
  const durationMs = Math.max(0, clock().getTime() - startMs);
  const principalId = check.engagement?.principalId ?? null;
  const folder = check.engagement?.folder ?? null;
  const outcome: CapabilityCheckOutcome = {
    assertion,
    token,
    recordedAtIso: clock().toISOString(),
    capability: check.capability,
    projectId: check.projectId,
    folder,
    principalId,
    branch: check.branch,
    path: check.path,
    ...(check.astNodeIds !== undefined ? { astNodeIds: check.astNodeIds } : {}),
    ...(check.astSelectors !== undefined
      ? { astSelectors: check.astSelectors }
      : {}),
  };
  try {
    await sink.recordCapabilityCheck(context, outcome, durationMs);
  } catch {
    /* best-effort — never flip the gate decision because of an audit throw */
  }
}

function statusCodeFor(kind: 'denied' | 'reauth_required'): number {
  return kind === 'denied' ? 403 : 401;
}

function buildDenied(
  kind: 'policy_denied' | 'reauth_required',
  statusCode: number,
  reason: CapabilityDeniedReason,
  check: CapabilityCheck,
  tokenId: string | null,
): CapabilityDeniedError {
  return new CapabilityDeniedError({
    kind,
    reason,
    statusCode,
    correlationId: check.correlationId,
    decisionId: null,
    policyVersion: null,
    tokenId,
    capability: check.capability,
    branch: check.branch,
    path: check.path,
  });
}
