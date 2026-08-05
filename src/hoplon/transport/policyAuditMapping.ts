/**
 * transport/policyAuditMapping.ts — pure mapping helpers between typed
 * handshake / lifecycle outcomes and the t-088 PolicyAuditEvent shape.
 *
 * Pure module (no I/O). Kept outside `policyAuditSink.ts` so the sink
 * file stays under the 300-line architecture cap and the reason-code
 * taxonomy is easy to re-read on its own. Callers should not expect
 * stability on internal helpers; the sink is the public surface.
 */

import type { AuditLogRecord } from '../contracts/auditLog.js';
import type {
  PolicyAuditEvent,
  PolicyAuditReason,
} from '../contracts/policyAudit.js';
import { canonicalizeProjectRelativeFolder } from '../concurrency/projectPolicy.js';
import type { HandshakeError } from '../launcher/handshake.js';
import {
  type HandshakeRequest,
  type HandshakeResult,
} from '../launcher/handshake.js';
import type {
  ReauthReason,
  TokenRenewal,
  TokenRevocation,
  TokenVerification,
  VerifyExpectation,
} from '../launcher/engagementLifecycle.js';

// ---------------------------------------------------------------------------
// Handshake mappers
// ---------------------------------------------------------------------------

export function handshakeGrantEvent(result: HandshakeResult): PolicyAuditEvent {
  return {
    reasonCode: 'handshake_granted',
    requestedAction: 'handshake',
    folder: result.folder,
    principalId: result.principalId,
    resolvedAccess: result.access,
    engagementId: null,
    detail: null,
  };
}

export function handshakeDenyEvent(
  request: HandshakeRequest,
  error: HandshakeError,
): PolicyAuditEvent {
  return {
    reasonCode: handshakeDenyReason(error),
    requestedAction: 'handshake',
    folder: canonicalFolderFromRequest(request, error),
    principalId: principalFromRequest(request, error),
    resolvedAccess: error.access ?? null,
    engagementId: null,
    detail: error.reason ?? null,
  };
}

function handshakeDenyReason(error: HandshakeError): PolicyAuditReason {
  switch (error.kind) {
    case 'invalid_request':
      return 'handshake_invalid_request';
    case 'unknown_project':
      return 'handshake_unknown_project';
    case 'no_folder_policy':
      return 'handshake_no_folder_policy';
    case 'invalid_folder':
      return 'handshake_invalid_folder';
    case 'policy_denied':
      return 'handshake_policy_denied';
    case 'unknown_principal':
      return 'handshake_unknown_principal';
  }
}

// ---------------------------------------------------------------------------
// Renew mappers
// ---------------------------------------------------------------------------

export function renewOutcomeMapping(
  outcome: TokenRenewal,
): { result: AuditLogRecord['result']; event: PolicyAuditEvent } {
  if (outcome.kind === 'renewed') {
    return {
      result: 'GRANTED',
      event: {
        reasonCode: 'renew_granted',
        requestedAction: 'renew',
        folder: outcome.binding.folder,
        principalId: outcome.binding.principalId,
        resolvedAccess: outcome.binding.access,
        engagementId: outcome.binding.nonce,
        detail: null,
      },
    };
  }
  return {
    result: 'REAUTH_REQUIRED',
    event: {
      reasonCode: renewDenyReason(outcome.reason),
      requestedAction: 'renew',
      folder: null,
      principalId: null,
      resolvedAccess: null,
      engagementId: null,
      detail: outcome.reason,
    },
  };
}

function renewDenyReason(reason: ReauthReason): PolicyAuditReason {
  switch (reason) {
    case 'missing':
      return 'renew_reauth_missing';
    case 'expired':
      return 'renew_reauth_expired';
    case 'invalid_request':
      return 'renew_reauth_invalid_request';
    case 'unknown_project':
      return 'renew_reauth_unknown_project';
    case 'no_folder_policy':
      return 'renew_reauth_no_folder_policy';
    case 'invalid_folder':
      return 'renew_reauth_invalid_folder';
    case 'policy_denied':
      return 'renew_reauth_policy_denied';
    case 'unknown_principal':
      return 'renew_reauth_unknown_principal';
  }
}

// ---------------------------------------------------------------------------
// Revoke mapper
// ---------------------------------------------------------------------------

export function revokeOutcomeMapping(
  outcome: TokenRevocation,
): { result: AuditLogRecord['result']; event: PolicyAuditEvent } {
  if (outcome.kind === 'revoked') {
    return {
      result: 'REVOKED',
      event: {
        reasonCode: 'revoke_completed',
        requestedAction: 'revoke',
        folder: outcome.binding.folder,
        principalId: outcome.binding.principalId,
        resolvedAccess: outcome.binding.access,
        engagementId: outcome.binding.nonce,
        detail: null,
      },
    };
  }
  return {
    result: 'REAUTH_REQUIRED',
    event: {
      reasonCode: 'revoke_missing_token',
      requestedAction: 'revoke',
      folder: null,
      principalId: null,
      resolvedAccess: null,
      engagementId: null,
      detail: null,
    },
  };
}

// ---------------------------------------------------------------------------
// Access-check mapper
// ---------------------------------------------------------------------------

export type GatedAction = 'read' | 'search' | 'edit';

export function accessCheckMapping(
  verification: TokenVerification,
  expectation: VerifyExpectation,
  action: GatedAction,
): { result: AuditLogRecord['result']; event: PolicyAuditEvent } {
  const { result, reasonCode } = classifyAccessCheck(verification);
  return {
    result,
    event: {
      reasonCode,
      requestedAction: action,
      folder: folderFromAccessCheck(verification, expectation),
      principalId: principalFromAccessCheck(verification, expectation),
      resolvedAccess:
        verification.kind === 'valid' ? verification.binding.access : null,
      engagementId:
        verification.kind === 'missing' ? null : verification.binding.nonce,
      detail:
        verification.kind === 'scope_mismatch' ? verification.reason : null,
    },
  };
}

function classifyAccessCheck(
  verification: TokenVerification,
): { result: AuditLogRecord['result']; reasonCode: PolicyAuditReason } {
  switch (verification.kind) {
    case 'valid':
      return { result: 'GRANTED', reasonCode: 'access_granted' };
    case 'missing':
      return { result: 'REAUTH_REQUIRED', reasonCode: 'access_missing_token' };
    case 'expired':
      return { result: 'REAUTH_REQUIRED', reasonCode: 'access_expired_token' };
    case 'scope_mismatch':
      switch (verification.reason) {
        case 'project_id':
          return {
            result: 'DENIED',
            reasonCode: 'access_scope_mismatch_project',
          };
        case 'folder':
          return {
            result: 'DENIED',
            reasonCode: 'access_scope_mismatch_folder',
          };
        case 'access':
          return {
            result: 'DENIED',
            reasonCode: 'access_scope_mismatch_access',
          };
        case 'principal':
          return {
            result: 'DENIED',
            reasonCode: 'access_scope_mismatch_principal',
          };
      }
  }
}

function folderFromAccessCheck(
  verification: TokenVerification,
  expectation: VerifyExpectation,
): string | null {
  if (verification.kind === 'missing') return expectation.folder ?? null;
  return verification.binding.folder;
}

function principalFromAccessCheck(
  verification: TokenVerification,
  expectation: VerifyExpectation,
): string | null {
  if (verification.kind === 'missing') {
    return expectation.principalId ?? null;
  }
  return verification.binding.principalId;
}

// ---------------------------------------------------------------------------
// H13 helpers — never persist raw invalid folder bytes in audit rows
// ---------------------------------------------------------------------------

function canonicalFolderFromRequest(
  request: HandshakeRequest,
  error: HandshakeError,
): string | null {
  if (error.kind === 'invalid_request') return null;
  const canonical = canonicalizeProjectRelativeFolder(request.folder);
  return canonical.ok ? canonical.canonical : null;
}

function principalFromRequest(
  request: HandshakeRequest,
  error: HandshakeError,
): string | null {
  if (error.kind === 'invalid_request') return null;
  if (
    typeof request.principalId !== 'string' ||
    request.principalId.length === 0
  ) {
    return null;
  }
  return request.principalId;
}
