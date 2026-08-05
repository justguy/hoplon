/**
 * transport/policyAuditEvidence.ts — t-148 bounded-redaction helpers +
 * handshake-authz outcome mapper.
 *
 * Pure module (no I/O). Holds:
 *   - `boundString` / `boundPathArray` / `boundGrantIds` / `boundAstArray`
 *     / `boundBranch` / `boundDetail` — enforce the `POLICY_AUDIT_MAX_*`
 *     caps from `contracts/policyAudit.ts`. When a cap is hit the dropped
 *     tail is replaced with a `POLICY_AUDIT_TRUNCATION_MARKER` entry.
 *   - `auditEngineFromName` — widens the freeform engine string from
 *     `CapabilityEngagementToken.policy.engine` into the closed union
 *     persisted on the audit row.
 *   - `mapHandshakeAuthzOutcome` — produces a `PolicyAuditEvent` for any
 *     dynamic-authz handshake outcome.
 *
 * The capability-gate mapping is in a sibling file
 * (`policyAuditCapability.ts`) so each file stays under the 300-line cap.
 *
 * Critical H13 invariant: the ALLOW handshake path takes `tokenId` from
 * `capabilityToken.tokenId` and NEVER from the opaque bearer token bytes
 * (`capabilityToken.token`). A unit test pins this.
 */

import {
  POLICY_AUDIT_MAX_AST_ENTRIES,
  POLICY_AUDIT_MAX_BRANCH_LENGTH,
  POLICY_AUDIT_MAX_DETAIL_LENGTH,
  POLICY_AUDIT_MAX_GRANT_IDS,
  POLICY_AUDIT_MAX_PATHS,
  POLICY_AUDIT_MAX_PATH_LENGTH,
  POLICY_AUDIT_TRUNCATION_MARKER,
  type PolicyAuditEngine,
  type PolicyAuditEvent,
  type PolicyAuditReason,
} from '../contracts/policyAudit.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type {
  CapabilityEngagementToken,
} from '../authorization/capabilityToken.js';
import type {
  HandshakeAuthzResult,
} from '../launcher/handshakeAuthz.js';
import { buildRbaaPolicyAuditEvidence } from './rbaaPolicyAuditEvidence.js';

// ---------------------------------------------------------------------------
// Bounded-redaction helpers
// ---------------------------------------------------------------------------

/** Truncate a string to `max` chars; append the truncation marker on overflow. */
export function boundString(value: string, max: number): string {
  if (value.length <= max) return value;
  const head = value.slice(
    0,
    Math.max(0, max - POLICY_AUDIT_TRUNCATION_MARKER.length),
  );
  return head + POLICY_AUDIT_TRUNCATION_MARKER;
}

export function boundPathArray(
  paths: ReadonlyArray<string> | undefined | null,
): { values: string[]; truncated: boolean } {
  return boundStringArray(paths, POLICY_AUDIT_MAX_PATHS, POLICY_AUDIT_MAX_PATH_LENGTH);
}

export function boundGrantIds(
  ids: ReadonlyArray<string> | undefined | null,
): { values: string[]; truncated: boolean } {
  return boundStringArray(ids, POLICY_AUDIT_MAX_GRANT_IDS, POLICY_AUDIT_MAX_PATH_LENGTH);
}

export function boundAstArray(
  values: ReadonlyArray<string> | undefined | null,
): { values: string[]; truncated: boolean } {
  return boundStringArray(values, POLICY_AUDIT_MAX_AST_ENTRIES, POLICY_AUDIT_MAX_PATH_LENGTH);
}

export function boundBranch(branch: string | undefined | null): string | null {
  if (branch === undefined || branch === null || branch.length === 0) {
    return null;
  }
  return boundString(branch, POLICY_AUDIT_MAX_BRANCH_LENGTH);
}

export function boundDetail(detail: string | undefined | null): string | null {
  if (detail === undefined || detail === null) return null;
  return boundString(detail, POLICY_AUDIT_MAX_DETAIL_LENGTH);
}

function boundStringArray(
  input: ReadonlyArray<string> | undefined | null,
  maxCount: number,
  maxLength: number,
): { values: string[]; truncated: boolean } {
  if (!Array.isArray(input) || input.length === 0) {
    return { values: [], truncated: false };
  }
  const truncated = input.length > maxCount;
  const limit = truncated ? Math.max(0, maxCount - 1) : input.length;
  const out: string[] = [];
  for (let i = 0; i < limit; i += 1) {
    const raw = input[i];
    if (typeof raw !== 'string') continue;
    out.push(raw.length > maxLength ? boundString(raw, maxLength) : raw);
  }
  if (truncated) out.push(POLICY_AUDIT_TRUNCATION_MARKER);
  return { values: out, truncated };
}

// ---------------------------------------------------------------------------
// Engine widener
// ---------------------------------------------------------------------------

export function auditEngineFromName(
  engine: string | undefined | null,
): PolicyAuditEngine {
  if (engine === 'static' || engine === 'opa') return engine;
  return 'unknown';
}

// ---------------------------------------------------------------------------
// Mapping return shape
// ---------------------------------------------------------------------------

export interface PolicyAuditMapping {
  readonly result: AuditLogRecord['result'];
  readonly event: PolicyAuditEvent;
}

// ---------------------------------------------------------------------------
// Handshake authz outcome → policy audit row mapping
// ---------------------------------------------------------------------------

export function mapHandshakeAuthzOutcome(
  result: HandshakeAuthzResult,
  engineName: string,
): PolicyAuditMapping {
  if (result.kind === 'allow') return mapAllowOutcome(result, engineName);
  if (
    result.kind === 'requires_escalation' ||
    result.kind === 'requires_approval'
  ) {
    return mapEscalationOutcome(result, engineName);
  }
  return mapDenyOutcome(result, engineName);
}

function mapAllowOutcome(
  result: HandshakeAuthzResult & { kind: 'allow' },
  engineName: string,
): PolicyAuditMapping {
  const branch = boundBranch(deriveBranchFromCapabilityToken(result.capabilityToken));
  const paths = boundPathArray(derivePathsFromCapabilityToken(result.capabilityToken));
  const grantIds = boundGrantIds(result.grantIds);
  const truncated = paths.truncated || grantIds.truncated;
  const event: PolicyAuditEvent = {
    reasonCode: 'handshake_granted',
    requestedAction: 'handshake',
    folder: result.folder,
    principalId: result.principalId,
    resolvedAccess: result.access,
    engagementId: null,
    detail: null,
    policyEngine: auditEngineFromName(
      result.capabilityToken.policy.engine ?? engineName,
    ),
    decisionId: result.decisionId,
    policyVersion: result.policyVersion,
    // CRITICAL H13 invariant: tokenId is the capability-token id
    // (`capabilityToken.tokenId`), NEVER `capabilityToken.token`
    // (the raw bearer bytes).
    tokenId: result.capabilityToken.tokenId,
    issuedTokenId: result.capabilityToken.tokenId,
    capability: null,
    branch,
    paths: paths.values.length > 0 ? paths.values : null,
    grantIds: grantIds.values.length > 0 ? grantIds.values : null,
    astNodeIds: null,
    astSelectors: null,
    truncated,
    rbaaEvidence: buildRbaaPolicyAuditEvidence(
      result.capabilityToken,
      'allow',
      result.capabilityToken.issuedAtIso,
    ),
  };
  return { result: 'GRANTED', event };
}

function mapEscalationOutcome(
  result: HandshakeAuthzResult & {
    kind: 'requires_escalation' | 'requires_approval';
  },
  engineName: string,
): PolicyAuditMapping {
  const reasonCode: PolicyAuditReason =
    result.kind === 'requires_escalation'
      ? 'handshake_requires_escalation'
      : 'handshake_requires_approval';
  const event: PolicyAuditEvent = {
    reasonCode,
    requestedAction: 'handshake',
    folder: result.folder,
    principalId: result.principalId,
    resolvedAccess: null,
    engagementId: null,
    detail: boundDetail(result.reason),
    policyEngine: auditEngineFromName(engineName),
    decisionId: result.decisionId,
    policyVersion: result.policyVersion,
    tokenId: null,
    issuedTokenId: null,
    capability: null,
    branch: null,
    paths: null,
    grantIds: null,
    astNodeIds: null,
    astSelectors: null,
  };
  return { result: 'REAUTH_REQUIRED', event };
}

function mapDenyOutcome(
  result: HandshakeAuthzResult & { kind: 'deny' },
  engineName: string,
): PolicyAuditMapping {
  const reasonCode = denyReasonCodeFromHandshakeAuthz(result.reason);
  const event: PolicyAuditEvent = {
    reasonCode,
    requestedAction: 'handshake',
    folder: result.folder,
    principalId: result.principalId,
    resolvedAccess: result.access,
    engagementId: null,
    detail: boundDetail(result.reason),
    policyEngine: auditEngineFromName(engineName),
    decisionId: result.decisionId,
    policyVersion: result.policyVersion,
    tokenId: null,
    issuedTokenId: null,
    capability: null,
    branch: null,
    paths: null,
    grantIds: null,
    astNodeIds: null,
    astSelectors: null,
  };
  return { result: 'DENIED', event };
}

function denyReasonCodeFromHandshakeAuthz(reason: string): PolicyAuditReason {
  if (reason.startsWith('adapter_error')) return 'handshake_adapter_error';
  if (reason === 'adapter_invalid_expires_in_seconds') {
    return 'handshake_adapter_invalid_expires';
  }
  if (reason === 'adapter_allow_with_empty_capabilities') {
    return 'handshake_adapter_empty_capabilities';
  }
  if (reason === 'adapter_malformed_decision') {
    return 'handshake_adapter_invalid_decision';
  }
  if (reason.startsWith('mint_error')) return 'handshake_mint_error';
  return 'handshake_policy_denied';
}

// ---------------------------------------------------------------------------
// Capability-token derivations (helpers shared with capability mapping)
// ---------------------------------------------------------------------------

const CAPABILITY_PRIORITY: ReadonlyArray<
  keyof CapabilityEngagementToken['capabilities']
> = ['write', 'search', 'read', 'lock', 'snapshot'];

function deriveBranchFromCapabilityToken(
  token: CapabilityEngagementToken,
): string | null {
  for (const key of CAPABILITY_PRIORITY) {
    const claim = token.capabilities[key];
    if (claim !== undefined && claim.branches.length > 0) {
      return claim.branches[0] ?? null;
    }
  }
  return null;
}

function derivePathsFromCapabilityToken(
  token: CapabilityEngagementToken,
): ReadonlyArray<string> {
  for (const key of CAPABILITY_PRIORITY) {
    const claim = token.capabilities[key];
    if (claim !== undefined && claim.paths.length > 0) {
      return claim.paths;
    }
  }
  return [];
}
