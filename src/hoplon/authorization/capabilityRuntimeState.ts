import type {
  CapabilityClaimsStore,
  CapabilityRuntimeState,
} from './capabilityClaimsStore.js';
import type { CapabilityEngagementToken } from './capabilityToken.js';
import type {
  CapabilityAssertionResult,
  CapabilityOpSpec,
} from './capabilityGate.js';

export interface EnforceCapabilityRuntimeStateArgs {
  readonly claimsStore: CapabilityClaimsStore;
  readonly tokenString: string;
  readonly token: CapabilityEngagementToken;
  readonly op: CapabilityOpSpec;
}

export function enforceCapabilityRuntimeState(
  args: EnforceCapabilityRuntimeStateArgs,
): CapabilityAssertionResult {
  const { claimsStore, tokenString, token, op } = args;
  const state = claimsStore.getRuntimeState(tokenString);
  if (state === null || state.tokenId !== token.tokenId) {
    return {
      kind: 'reauth_required',
      reason: 'missing_runtime_state',
      field: 'runtimeState',
    };
  }
  if (state.revokedAtIso !== undefined) {
    return { kind: 'denied', reason: 'token_revoked' };
  }
  if (state.quarantinedAtIso !== undefined) {
    return { kind: 'denied', reason: 'token_quarantined' };
  }
  if (grantRevoked(token, state)) {
    return { kind: 'denied', reason: 'grant_revoked' };
  }

  const operationLimit = operationLimitFor(token, op);
  if (operationLimit.kind === 'invalid') {
    return {
      kind: 'denied',
      reason: 'invalid_token',
      field: operationLimit.field,
    };
  }
  if (
    operationLimit.kind === 'value' &&
    state.operationCount >= operationLimit.value
  ) {
    return {
      kind: 'reauth_required',
      reason: 'operation_limit_exceeded',
      field: op.capability,
    };
  }

  const touchedFiles = nextTouchedFiles(state.touchedFiles, op.path);
  const fileLimit = fileLimitFor(token, op);
  if (fileLimit.kind === 'invalid') {
    return {
      kind: 'denied',
      reason: 'invalid_token',
      field: fileLimit.field,
    };
  }
  if (fileLimit.kind === 'value' && touchedFiles.length > fileLimit.value) {
    return {
      kind: 'reauth_required',
      reason: 'file_touch_limit_exceeded',
      field: op.path,
    };
  }

  claimsStore.putRuntimeState(tokenString, {
    ...state,
    operationCount: state.operationCount + 1,
    touchedFiles,
  });
  return { kind: 'ok' };
}

function grantRevoked(
  token: CapabilityEngagementToken,
  state: CapabilityRuntimeState,
): boolean {
  const revoked = state.revokedGrantIds ?? [];
  if (revoked.length === 0) return false;
  const grantIds = token.policy.grantIds ?? [];
  return grantIds.some((grantId) => revoked.includes(grantId));
}

function operationLimitFor(
  token: CapabilityEngagementToken,
  op: CapabilityOpSpec,
): RuntimeLimit {
  return runtimeLimit(
    token.capabilities[op.capability]?.maxOperations,
    token.policy.rbaa?.limits.maxOperations,
    `capabilities.${op.capability}.maxOperations`,
    'policy.rbaa.limits.maxOperations',
  );
}

function fileLimitFor(
  token: CapabilityEngagementToken,
  op: CapabilityOpSpec,
): RuntimeLimit {
  return runtimeLimit(
    token.capabilities[op.capability]?.maxFilesTouched,
    token.policy.rbaa?.limits.maxFilesTouched,
    `capabilities.${op.capability}.maxFilesTouched`,
    'policy.rbaa.limits.maxFilesTouched',
  );
}

type RuntimeLimit =
  | { readonly kind: 'none' }
  | { readonly kind: 'value'; readonly value: number }
  | { readonly kind: 'invalid'; readonly field: string };

function runtimeLimit(
  claimValue: number | undefined,
  rbaaValue: number | undefined,
  claimField: string,
  rbaaField: string,
): RuntimeLimit {
  if (claimValue !== undefined) return positiveInteger(claimValue, claimField);
  if (rbaaValue !== undefined) return positiveInteger(rbaaValue, rbaaField);
  return { kind: 'none' };
}

function positiveInteger(value: number, field: string): RuntimeLimit {
  if (!Number.isInteger(value) || value <= 0) {
    return { kind: 'invalid', field };
  }
  return { kind: 'value', value };
}

function nextTouchedFiles(
  current: readonly string[],
  path: string,
): readonly string[] {
  if (path.length === 0 || current.includes(path)) return [...current];
  return [...current, path];
}
