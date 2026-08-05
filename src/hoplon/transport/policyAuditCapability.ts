/**
 * transport/policyAuditCapability.ts — t-148 capability-gate outcome
 * mapper.
 *
 * Pure module. Translates a `CapabilityAssertionResult` (the typed
 * outcome of `assertCapability` / `verifyCapabilityAccess`) plus the
 * request envelope into a `POLICY_CAPABILITY_CHECK` audit row mapping.
 *
 * Lives in a sibling file to `policyAuditEvidence.ts` so each pure
 * module stays under the 300-line architecture cap and the typed
 * reason-code catalog is easy to read on its own.
 */

import {
  type PolicyAuditCapability,
  type PolicyAuditEvent,
  type PolicyAuditReason,
} from '../contracts/policyAudit.js';
import type { AuditLogRecord } from '../contracts/auditLog.js';
import type {
  CapabilityAssertionResult,
  CapabilityDeniedReason,
  CapabilityKey,
} from '../authorization/capabilityGate.js';
import type {
  CapabilityEngagementToken,
} from '../authorization/capabilityToken.js';
import {
  auditEngineFromName,
  boundAstArray,
  boundBranch,
  boundDetail,
  boundGrantIds,
  boundPathArray,
  type PolicyAuditMapping,
} from './policyAuditEvidence.js';
import { buildRbaaPolicyAuditEvidence } from './rbaaPolicyAuditEvidence.js';

export interface CapabilityCheckOutcome {
  readonly assertion: CapabilityAssertionResult;
  readonly token: CapabilityEngagementToken | null;
  readonly capability: CapabilityKey;
  readonly projectId: string;
  readonly folder: string | null;
  readonly principalId: string | null;
  readonly branch: string;
  readonly path: string;
  readonly astNodeIds?: ReadonlyArray<string>;
  readonly astSelectors?: ReadonlyArray<string>;
  readonly recordedAtIso?: string;
}

export function mapCapabilityCheck(
  outcome: CapabilityCheckOutcome,
): PolicyAuditMapping {
  const result = capabilityCheckResult(outcome.assertion);
  const reasonCode = capabilityReasonCode(outcome.assertion);
  const paths = boundPathArray(outcome.path.length > 0 ? [outcome.path] : []);
  const astNodes = boundAstArray(outcome.astNodeIds);
  const astSelectors = boundAstArray(outcome.astSelectors);
  const grantIds = boundGrantIds(outcome.token?.policy.grantIds);
  const detail = capabilityCheckDetail(outcome.assertion);
  const truncated =
    paths.truncated ||
    astNodes.truncated ||
    astSelectors.truncated ||
    grantIds.truncated;

  const event: PolicyAuditEvent = {
    reasonCode,
    requestedAction: outcome.capability,
    folder: outcome.folder,
    principalId: outcome.principalId,
    resolvedAccess: null,
    engagementId: null,
    detail,
    policyEngine: auditEngineFromName(outcome.token?.policy.engine ?? null),
    decisionId: outcome.token?.policy.decisionId ?? null,
    policyVersion: outcome.token?.policy.policyVersion ?? null,
    tokenId: outcome.token?.tokenId ?? null,
    issuedTokenId: null,
    capability: outcome.capability satisfies PolicyAuditCapability,
    branch: boundBranch(outcome.branch),
    paths: paths.values.length > 0 ? paths.values : null,
    grantIds: grantIds.values.length > 0 ? grantIds.values : null,
    astNodeIds: astNodes.values.length > 0 ? astNodes.values : null,
    astSelectors: astSelectors.values.length > 0 ? astSelectors.values : null,
    truncated,
    rbaaEvidence: buildRbaaPolicyAuditEvidence(
      outcome.token,
      rbaaOutcomeFromAssertion(outcome.assertion),
      outcome.recordedAtIso ?? outcome.token?.issuedAtIso ?? new Date(0).toISOString(),
    ),
  };
  return { result, event };
}

function rbaaOutcomeFromAssertion(
  assertion: CapabilityAssertionResult,
): 'allow' | 'requires_escalation' | 'deny' {
  if (assertion.kind === 'ok') return 'allow';
  if (assertion.kind === 'reauth_required') return 'requires_escalation';
  return 'deny';
}

function capabilityCheckResult(
  assertion: CapabilityAssertionResult,
): AuditLogRecord['result'] {
  if (assertion.kind === 'ok') return 'GRANTED';
  if (assertion.kind === 'reauth_required') return 'REAUTH_REQUIRED';
  return 'DENIED';
}

function capabilityCheckDetail(
  assertion: CapabilityAssertionResult,
): string | null {
  if (assertion.kind === 'ok') return null;
  if (assertion.field !== undefined && assertion.field.length > 0) {
    return boundDetail(`${assertion.reason}:${assertion.field}`);
  }
  return boundDetail(assertion.reason);
}

function capabilityReasonCode(
  assertion: CapabilityAssertionResult,
): PolicyAuditReason {
  if (assertion.kind === 'ok') return 'capability_granted';
  return reasonForCapabilityDenied(assertion.kind, assertion.reason);
}

function reasonForCapabilityDenied(
  kind: 'denied' | 'reauth_required',
  reason: CapabilityDeniedReason,
): PolicyAuditReason {
  if (kind === 'denied') return mapDeniedReason(reason);
  return mapReauthReason(reason);
}

function mapDeniedReason(reason: CapabilityDeniedReason): PolicyAuditReason {
  switch (reason) {
    case 'capability_missing':
      return 'capability_denied_capability_missing';
    case 'project_mismatch':
      return 'capability_denied_project_mismatch';
    case 'session_mismatch':
      return 'capability_denied_session_mismatch';
    case 'task_mismatch':
      return 'capability_denied_task_mismatch';
    case 'principal_mismatch':
      return 'capability_denied_principal_mismatch';
    case 'branch_mismatch':
      return 'capability_denied_branch_mismatch';
    case 'path_mismatch':
      return 'capability_denied_path_mismatch';
    case 'denied_path_match':
      return 'capability_denied_denied_path_match';
    case 'ast_mismatch':
      return 'capability_denied_ast_mismatch';
    case 'token_revoked':
      return 'capability_denied_token_revoked';
    case 'grant_revoked':
      return 'capability_denied_grant_revoked';
    case 'token_quarantined':
      return 'capability_denied_token_quarantined';
    case 'invalid_token':
    case 'token_expired':
    case 'missing_branch':
    case 'missing_path':
    case 'missing_ast_coords':
    case 'missing_runtime_state':
    case 'operation_limit_exceeded':
    case 'file_touch_limit_exceeded':
      // These should only appear under `reauth_required`; map defensively
      // if a future change surfaces them on the `denied` branch.
      return 'capability_denied_invalid_token';
  }
}

function mapReauthReason(reason: CapabilityDeniedReason): PolicyAuditReason {
  switch (reason) {
    case 'token_expired':
      return 'capability_reauth_token_expired';
    case 'missing_branch':
      return 'capability_reauth_missing_branch';
    case 'missing_path':
      return 'capability_reauth_missing_path';
    case 'missing_ast_coords':
      return 'capability_reauth_missing_ast_coords';
    case 'missing_runtime_state':
      return 'capability_reauth_missing_runtime_state';
    case 'operation_limit_exceeded':
      return 'capability_reauth_operation_limit_exceeded';
    case 'file_touch_limit_exceeded':
      return 'capability_reauth_file_touch_limit_exceeded';
    case 'invalid_token':
    case 'capability_missing':
    case 'project_mismatch':
    case 'session_mismatch':
    case 'task_mismatch':
    case 'principal_mismatch':
    case 'branch_mismatch':
    case 'path_mismatch':
    case 'denied_path_match':
    case 'ast_mismatch':
    case 'token_revoked':
    case 'grant_revoked':
    case 'token_quarantined':
      return 'capability_reauth_invalid_token';
  }
}
