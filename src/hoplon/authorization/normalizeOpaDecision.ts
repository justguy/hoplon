/**
 * authorization/normalizeOpaDecision.ts — pure normalization of raw OPA
 * decision payloads into `HoplonAuthorizationDecision` (T-145).
 *
 * Responsibilities:
 *   - Validate that the raw payload is an object with one of the four
 *     allowed `outcome` strings.
 *   - For `allow`: validate `source`, `capabilities`, `expiresInSeconds`,
 *     `decisionId`, `policyVersion`, optional `grantIds`. Reject vague
 *     roles (empty capabilities map).
 *   - For `requires_escalation` / `requires_approval`: validate the
 *     `escalationKind` is in the allowed enum, plus `requestedScope`,
 *     `reason`, `decisionId`, `policyVersion`.
 *   - For `deny`: validate `reason`, `decisionId`, `policyVersion`.
 *
 * Failure semantics: returns `{ kind: 'ok', decision }` or
 *   `{ kind: 'malformed', field, reason }` so callers can fail closed
 *   deterministically without try/catch.
 *
 * Permissiveness: extra fields outside the schema are silently ignored.
 *   OPA may add new fields over time; required fields are still strict.
 *
 * Architecture rules:
 *   - Pure function. No I/O, no clock, no randomness.
 *   - Named exports only. TypeScript strict. No `any`.
 */
import type { HoplonAuthorizationDecision } from './authorizationAdapter.js';
import {
  countCapabilities,
  normalizeCapabilities,
} from './normalizeScopeClaim.js';

/** Result envelope from `normalizeOpaDecision`. */
export type NormalizeOpaDecisionResult =
  | { kind: 'ok'; decision: HoplonAuthorizationDecision }
  | { kind: 'malformed'; field: string; reason: string };

const ALLOWED_OUTCOMES = new Set([
  'allow',
  'requires_escalation',
  'requires_approval',
  'deny',
]);

const ALLOWED_ALLOW_SOURCES = new Set([
  'standing_policy',
  'escalation_grant',
  'break_glass',
]);

const ESCALATION_KINDS_ESCALATION = new Set([
  'self_service',
  'cto_approval',
  'human_approval',
  'security_approval',
  'platform_approval',
  'dba_approval',
]);

const ESCALATION_KINDS_APPROVAL = new Set([
  'human_approval',
  'security_approval',
  'platform_approval',
  'dba_approval',
]);

/**
 * Normalize a raw OPA decision payload into a typed
 * `HoplonAuthorizationDecision`. Returns a typed result; never throws.
 */
export function normalizeOpaDecision(
  raw: unknown,
): NormalizeOpaDecisionResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'malformed',
      field: 'root',
      reason: 'OPA decision is not a non-null object',
    };
  }
  const obj = raw as Record<string, unknown>;

  const outcome = obj['outcome'];
  if (typeof outcome !== 'string' || !ALLOWED_OUTCOMES.has(outcome)) {
    return {
      kind: 'malformed',
      field: 'outcome',
      reason: `outcome must be one of allow|requires_escalation|requires_approval|deny (got ${JSON.stringify(outcome)})`,
    };
  }

  const decisionIdResult = readNonEmptyString(obj, 'decisionId');
  if (decisionIdResult.kind === 'err') return decisionIdResult.err;
  const decisionId = decisionIdResult.value;

  const policyVersionResult = readNonEmptyString(obj, 'policyVersion');
  if (policyVersionResult.kind === 'err') return policyVersionResult.err;
  const policyVersion = policyVersionResult.value;

  if (outcome === 'allow') {
    return normalizeAllow(obj, decisionId, policyVersion);
  }
  if (
    outcome === 'requires_escalation' ||
    outcome === 'requires_approval'
  ) {
    return normalizeEscalation(obj, decisionId, policyVersion, outcome);
  }
  // outcome === 'deny'
  const reasonResult = readNonEmptyString(obj, 'reason');
  if (reasonResult.kind === 'err') return reasonResult.err;
  return {
    kind: 'ok',
    decision: {
      outcome: 'deny',
      reason: reasonResult.value,
      decisionId,
      policyVersion,
    },
  };
}

// ─── allow ────────────────────────────────────────────────────────────────

function normalizeAllow(
  obj: Record<string, unknown>,
  decisionId: string,
  policyVersion: string,
): NormalizeOpaDecisionResult {
  const source = obj['source'];
  if (typeof source !== 'string' || !ALLOWED_ALLOW_SOURCES.has(source)) {
    return {
      kind: 'malformed',
      field: 'source',
      reason: `allow.source must be one of standing_policy|escalation_grant|break_glass (got ${JSON.stringify(source)})`,
    };
  }

  const capabilitiesResult = normalizeCapabilities(obj['capabilities']);
  if (capabilitiesResult.kind === 'malformed') return capabilitiesResult;
  const capabilities = capabilitiesResult.capabilities;

  // Reject vague roles: an `allow` must carry concrete capabilities.
  if (countCapabilities(capabilities) === 0) {
    return {
      kind: 'malformed',
      field: 'capabilities',
      reason: 'allow decision must include at least one concrete capability (vague-role rejection)',
    };
  }

  const expiresRaw = obj['expiresInSeconds'];
  if (
    typeof expiresRaw !== 'number' ||
    !Number.isFinite(expiresRaw) ||
    expiresRaw <= 0
  ) {
    return {
      kind: 'malformed',
      field: 'expiresInSeconds',
      reason: 'expiresInSeconds must be a finite positive number',
    };
  }
  const expiresInSeconds = expiresRaw;

  let grantIds: string[] | undefined;
  if (obj['grantIds'] !== undefined) {
    const gids = obj['grantIds'];
    if (!Array.isArray(gids)) {
      return {
        kind: 'malformed',
        field: 'grantIds',
        reason: 'grantIds must be an array of strings when present',
      };
    }
    for (let i = 0; i < gids.length; i++) {
      const v = gids[i];
      if (typeof v !== 'string' || v.length === 0) {
        return {
          kind: 'malformed',
          field: `grantIds[${String(i)}]`,
          reason: 'each grantId must be a non-empty string',
        };
      }
    }
    grantIds = gids as string[];
  }

  const decision: HoplonAuthorizationDecision = {
    outcome: 'allow',
    source: source as 'standing_policy' | 'escalation_grant' | 'break_glass',
    capabilities,
    expiresInSeconds,
    decisionId,
    policyVersion,
    ...(grantIds !== undefined ? { grantIds } : {}),
  };
  return { kind: 'ok', decision };
}

// ─── escalation / approval ────────────────────────────────────────────────

function normalizeEscalation(
  obj: Record<string, unknown>,
  decisionId: string,
  policyVersion: string,
  outcome: 'requires_escalation' | 'requires_approval',
): NormalizeOpaDecisionResult {
  const escalationKindRaw = obj['escalationKind'];
  const allowed =
    outcome === 'requires_escalation'
      ? ESCALATION_KINDS_ESCALATION
      : ESCALATION_KINDS_APPROVAL;
  if (
    typeof escalationKindRaw !== 'string' ||
    !allowed.has(escalationKindRaw)
  ) {
    return {
      kind: 'malformed',
      field: 'escalationKind',
      reason: `escalationKind for ${outcome} must be one of ${[...allowed].join('|')} (got ${JSON.stringify(escalationKindRaw)})`,
    };
  }

  const requestedScopeResult = normalizeCapabilities(obj['requestedScope']);
  if (requestedScopeResult.kind === 'malformed') {
    // Surface the same shape but rename the field path for clarity.
    return {
      kind: 'malformed',
      field: requestedScopeResult.field.replace(
        /^capabilities/,
        'requestedScope',
      ),
      reason: requestedScopeResult.reason,
    };
  }
  const requestedScope = requestedScopeResult.capabilities;

  const reasonResult = readNonEmptyString(obj, 'reason');
  if (reasonResult.kind === 'err') return reasonResult.err;

  // The two outcomes share an identical decision shape; the
  // escalationKind enum is narrowed by the `allowed` set check above,
  // and TypeScript discriminates on `outcome`.
  const decision: HoplonAuthorizationDecision =
    outcome === 'requires_escalation'
      ? {
          outcome: 'requires_escalation',
          escalationKind: escalationKindRaw as
            | 'self_service'
            | 'cto_approval'
            | 'human_approval'
            | 'security_approval'
            | 'platform_approval'
            | 'dba_approval',
          requestedScope,
          reason: reasonResult.value,
          decisionId,
          policyVersion,
        }
      : {
          outcome: 'requires_approval',
          escalationKind: escalationKindRaw as
            | 'human_approval'
            | 'security_approval'
            | 'platform_approval'
            | 'dba_approval',
          requestedScope,
          reason: reasonResult.value,
          decisionId,
          policyVersion,
        };
  return { kind: 'ok', decision };
}

// ─── helpers ──────────────────────────────────────────────────────────────

type NonEmptyStringResult =
  | { kind: 'ok'; value: string }
  | { kind: 'err'; err: NormalizeOpaDecisionResult };

function readNonEmptyString(
  obj: Record<string, unknown>,
  field: string,
): NonEmptyStringResult {
  const v = obj[field];
  if (typeof v !== 'string' || v.length === 0) {
    return {
      kind: 'err',
      err: {
        kind: 'malformed',
        field,
        reason: `${field} must be a non-empty string`,
      },
    };
  }
  return { kind: 'ok', value: v };
}
