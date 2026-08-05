/**
 * transport/policyAuditSink.ts — single durable write-side sink for
 * t-088 + t-148 policy audit evidence.
 *
 * One sink, many consumers. HTTP project routes, MCP project tools, and
 * any future packaged handler convert their typed handshake /
 * lifecycle / gated-access / dynamic-authz / capability-gate outcomes
 * into `PolicyAuditEvent` rows on `hoplon_audit_log` through this
 * module. There is no second log and no per-transport audit shape — the
 * rules in t-088's task brief ("reuse `hoplon_audit_log` or an additive
 * extension of it") are enforced here, and t-148 extends the same sink
 * additively (no second store).
 *
 * H13 is preserved by construction via the mapping helpers: every
 * emitter forwards canonical folders only (never raw user input), the
 * binding `nonce` as the engagement correlation id (never the token),
 * and the reason-code closed union (never free-form text). The t-148
 * dynamic-authz mapper additionally pins `tokenId` / `issuedTokenId` to
 * `CapabilityEngagementToken.tokenId` (random hex), NEVER the raw bearer
 * bytes.
 *
 * The sink is permitted to fail best-effort: `appendAuditLog` errors
 * are swallowed so that a transient audit write does NOT change the
 * access-control decision. Observability hook (`onWriteFailure`) lets
 * transports surface failures when useful.
 */

import { randomUUID } from 'node:crypto';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type { PolicyAuditEvent } from '../contracts/policyAudit.js';
import type { HandshakeError } from '../launcher/handshake.js';
import {
  type HandshakeRequest,
  type HandshakeResult,
} from '../launcher/handshake.js';
import type {
  TokenRenewal,
  TokenRevocation,
  TokenVerification,
  VerifyExpectation,
} from '../launcher/engagementLifecycle.js';
import type { HandshakeAuthzResult } from '../launcher/handshakeAuthz.js';
import {
  accessCheckMapping,
  handshakeDenyEvent,
  handshakeGrantEvent,
  renewOutcomeMapping,
  revokeOutcomeMapping,
  type GatedAction,
} from './policyAuditMapping.js';
import { mapHandshakeAuthzOutcome } from './policyAuditEvidence.js';
import { mapCapabilityCheck, type CapabilityCheckOutcome } from './policyAuditCapability.js';
import { emitPolicyAuditTelemetry } from './policyAuditTelemetry.js';

// ---------------------------------------------------------------------------
// Public surface — types
// ---------------------------------------------------------------------------

export interface PolicyAuditContext {
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly snapshotId?: string | null;
}

export type { GatedAction } from './policyAuditMapping.js';
export type { CapabilityCheckOutcome } from './policyAuditCapability.js';

export interface PolicyAuditSink {
  recordHandshakeGrant(
    context: PolicyAuditContext,
    request: HandshakeRequest,
    result: HandshakeResult,
    durationMs: number,
  ): Promise<void>;

  recordHandshakeDeny(
    context: PolicyAuditContext,
    request: HandshakeRequest,
    error: HandshakeError,
    durationMs: number,
  ): Promise<void>;

  /**
   * t-148 — record any dynamic-authz handshake outcome (allow,
   * requires_escalation, requires_approval, deny, adapter-error). The
   * sink derives the operation/result/event from `result.kind` and the
   * caller-supplied `engineName` (used to populate `policyEngine` on
   * adapter-error rows where no token has been minted yet).
   */
  recordHandshakeAuthzOutcome(
    context: PolicyAuditContext,
    result: HandshakeAuthzResult,
    engineName: string,
    durationMs: number,
  ): Promise<void>;

  recordAccessCheck(
    context: PolicyAuditContext,
    action: GatedAction,
    expectation: VerifyExpectation,
    verification: TokenVerification,
    durationMs: number,
  ): Promise<void>;

  /**
   * t-148 — record one capability-gate outcome row (ok, denied,
   * reauth_required) under `POLICY_CAPABILITY_CHECK`. Owns the row in
   * the dynamic-authz lane (the legacy strict engagement gate continues
   * to own its own `POLICY_ACCESS_CHECK` rows under t-088).
   */
  recordCapabilityCheck(
    context: PolicyAuditContext,
    outcome: CapabilityCheckOutcome,
    durationMs: number,
  ): Promise<void>;

  recordRenew(
    context: PolicyAuditContext,
    outcome: TokenRenewal,
    durationMs: number,
  ): Promise<void>;

  recordRevoke(
    context: PolicyAuditContext,
    outcome: TokenRevocation,
    durationMs: number,
  ): Promise<void>;
}

export interface CreatePolicyAuditSinkDeps {
  readonly store: SnapshotStore;
  readonly engineId: string;
  readonly clock?: () => Date;
  readonly idFactory?: () => string;
  /**
   * Best-effort audit-write failure callback. When supplied, the sink
   * hands the error to this callback instead of silently swallowing.
   * The access-control decision is never changed — this hook is for
   * observability only.
   */
  readonly onWriteFailure?: (err: unknown) => void;
  readonly emitter?: HoplonEmitter;
}

// ---------------------------------------------------------------------------
// Factory — durable sink
// ---------------------------------------------------------------------------

export function createPolicyAuditSink(
  deps: CreatePolicyAuditSinkDeps,
): PolicyAuditSink {
  const clock = deps.clock ?? (() => new Date());
  const id = deps.idFactory ?? randomUUID;

  async function append(
    context: PolicyAuditContext,
    operation: AuditLogRecord['operation'],
    result: AuditLogRecord['result'],
    event: PolicyAuditEvent,
    durationMs: number,
  ): Promise<void> {
    const record: AuditLogRecord = {
      id: id(),
      snapshotId: context.snapshotId ?? null,
      projectId: context.projectId,
      runId: context.runId,
      engineId: deps.engineId,
      correlationId: context.correlationId,
      operation,
      result,
      violationCount: 0,
      violationKinds: [],
      durationMs,
      createdAt: clock().toISOString(),
      policyEvent: event,
    };
    let writeFailed = false;
    try {
      await deps.store.appendAuditLog(record);
    } catch (err) {
      writeFailed = true;
      deps.onWriteFailure?.(err);
    }
    emitPolicyAuditTelemetry({
      ...(deps.emitter !== undefined ? { emitter: deps.emitter } : {}),
      context,
      engineId: deps.engineId,
      operation, result, event, durationMs,
      auditRowCount: writeFailed ? 0 : 1,
      writeFailed,
    });
  }

  return {
    async recordHandshakeGrant(context, _request, result, durationMs) {
      await append(
        context,
        'POLICY_HANDSHAKE',
        'GRANTED',
        handshakeGrantEvent(result),
        durationMs,
      );
    },

    async recordHandshakeDeny(context, request, error, durationMs) {
      await append(
        context,
        'POLICY_HANDSHAKE',
        'DENIED',
        handshakeDenyEvent(request, error),
        durationMs,
      );
    },

    async recordHandshakeAuthzOutcome(context, result, engineName, durationMs) {
      const mapping = mapHandshakeAuthzOutcome(result, engineName);
      await append(
        context,
        'POLICY_HANDSHAKE',
        mapping.result,
        mapping.event,
        durationMs,
      );
    },

    async recordAccessCheck(
      context,
      action,
      expectation,
      verification,
      durationMs,
    ) {
      const mapping = accessCheckMapping(verification, expectation, action);
      await append(
        context,
        'POLICY_ACCESS_CHECK',
        mapping.result,
        mapping.event,
        durationMs,
      );
    },

    async recordCapabilityCheck(context, outcome, durationMs) {
      const mapping = mapCapabilityCheck(outcome);
      await append(
        context,
        'POLICY_CAPABILITY_CHECK',
        mapping.result,
        mapping.event,
        durationMs,
      );
    },

    async recordRenew(context, outcome, durationMs) {
      const mapping = renewOutcomeMapping(outcome);
      await append(
        context,
        'POLICY_RENEW',
        mapping.result,
        mapping.event,
        durationMs,
      );
    },

    async recordRevoke(context, outcome, durationMs) {
      const mapping = revokeOutcomeMapping(outcome);
      await append(
        context,
        'POLICY_REVOKE',
        mapping.result,
        mapping.event,
        durationMs,
      );
    },
  };
}

/**
 * No-op sink for stand-alone CLI tests / deterministic scaffolding so
 * callers never branch on presence.
 */
export function createNoopPolicyAuditSink(): PolicyAuditSink {
  const noop = async (): Promise<void> => {};
  return {
    recordHandshakeGrant: noop,
    recordHandshakeDeny: noop,
    recordHandshakeAuthzOutcome: noop,
    recordAccessCheck: noop,
    recordCapabilityCheck: noop,
    recordRenew: noop,
    recordRevoke: noop,
  };
}

export { auditedVerifyEngagementToken } from './policyAuditAccess.js';
