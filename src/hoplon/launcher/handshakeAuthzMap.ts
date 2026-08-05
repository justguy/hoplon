/**
 * launcher/handshakeAuthzMap.ts — decision → result mapper for the
 * T-146 dynamic-authorization handshake seam.
 *
 * Pure module: takes a typed `HoplonAuthorizationDecision` plus the
 * original handshake context and returns a `HandshakeAuthzResult`. The
 * `allow` branch mints a `CapabilityEngagementToken` and writes the
 * base binding to the engagement store. Non-allow branches never mint
 * a token.
 *
 * Kept separate from `handshakeAuthz.ts` so each file stays under the
 * 300-line architecture cap.
 */
import { randomBytes } from 'node:crypto';

import type {
  EngagementTokenBinding,
  EngagementTokenEnvelope,
} from '../concurrency/projectPolicy.js';
import type {
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from '../authorization/authorizationAdapter.js';
import {
  CapabilityTokenError,
  mintCapabilityToken,
  type CapabilityEngagementToken,
} from '../authorization/capabilityToken.js';
import {
  type HandshakeMatchedRuleSummary,
  type HandshakeRequest,
  type HandshakeResult,
  DEFAULT_ENGAGEMENT_TOKEN_BYTES,
} from './handshake.js';
import {
  legacyAccessFromCapabilities,
  type HandshakeAuthzResult,
  type IssueHandshakeViaAdapterDeps,
} from './handshakeAuthzTypes.js';
import { randomNonce } from './handshakeAuthzInternals.js';

const DEFAULT_ENGAGEMENT_NONCE_BYTES = 16;

export interface MapDecisionArgs {
  readonly request: HandshakeRequest;
  readonly decision: HoplonAuthorizationDecision;
  readonly adapterRequest: HoplonAuthorizationRequest;
  readonly deps: IssueHandshakeViaAdapterDeps;
  readonly principalId: string | null;
  readonly now: Date;
  /**
   * Resolution kind from the static FolderPolicy resolver, harvested by
   * the orchestrator so the legacy `resolution` and `matchedRule`
   * fields on the response envelope stay populated. The adapter's
   * decision still owns allow/deny — these fields are response shape only.
   */
  readonly resolutionKind: HandshakeResult['resolution'];
  readonly matchedRule: HandshakeMatchedRuleSummary | null;
}

export function mapDecisionToResult(args: MapDecisionArgs): HandshakeAuthzResult {
  // Folder has already been canonicalized by the orchestrator; trust it.
  const folder = args.request.folder;
  const { decision, request, principalId } = args;

  if (decision.outcome === 'requires_escalation') {
    return {
      kind: 'requires_escalation',
      projectId: request.projectId,
      folder,
      principalId,
      escalationKind: decision.escalationKind,
      requestedScope: decision.requestedScope,
      reason: decision.reason,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
    };
  }
  if (decision.outcome === 'requires_approval') {
    return {
      kind: 'requires_approval',
      projectId: request.projectId,
      folder,
      principalId,
      escalationKind: decision.escalationKind,
      requestedScope: decision.requestedScope,
      reason: decision.reason,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
    };
  }
  if (decision.outcome === 'deny') {
    return {
      kind: 'deny',
      projectId: request.projectId,
      folder,
      principalId,
      access: 'none',
      reason: decision.reason,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
    };
  }
  if (decision.outcome !== 'allow') {
    return {
      kind: 'deny',
      projectId: request.projectId,
      folder,
      principalId,
      access: 'none',
      reason: 'adapter_malformed_decision',
      decisionId: `adapter-error-${randomNonce()}`,
      policyVersion: 'adapter-error',
    };
  }

  if (
    typeof decision.expiresInSeconds !== 'number' ||
    !Number.isFinite(decision.expiresInSeconds) ||
    decision.expiresInSeconds <= 0
  ) {
    return {
      kind: 'deny',
      projectId: request.projectId,
      folder,
      principalId,
      access: 'none',
      reason: 'adapter_invalid_expires_in_seconds',
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
    };
  }

  return finalizeAllow({
    request,
    decision,
    adapterRequest: args.adapterRequest,
    deps: args.deps,
    principalId,
    now: args.now,
    folder,
    resolutionKind: args.resolutionKind,
    matchedRule: args.matchedRule,
  });
}

interface FinalizeAllowArgs {
  readonly request: HandshakeRequest;
  readonly decision: HoplonAuthorizationDecision & { outcome: 'allow' };
  readonly adapterRequest: HoplonAuthorizationRequest;
  readonly deps: IssueHandshakeViaAdapterDeps;
  readonly principalId: string | null;
  readonly now: Date;
  readonly folder: string;
  readonly resolutionKind: HandshakeResult['resolution'];
  readonly matchedRule: HandshakeMatchedRuleSummary | null;
}

function finalizeAllow(args: FinalizeAllowArgs): HandshakeAuthzResult {
  const access = legacyAccessFromCapabilities(args.decision.capabilities);
  if (access === 'none') {
    return {
      kind: 'deny',
      projectId: args.request.projectId,
      folder: args.folder,
      principalId: args.principalId,
      access: 'none',
      reason: 'adapter_allow_with_empty_capabilities',
      decisionId: args.decision.decisionId,
      policyVersion: args.decision.policyVersion,
    };
  }

  const issuedAtIso = args.now.toISOString();
  const expiresAtIso = new Date(
    args.now.getTime() + args.decision.expiresInSeconds * 1000,
  ).toISOString();
  const tokenString = (args.deps.randomToken ?? defaultToken)();
  const nonce = (args.deps.randomNonce ?? defaultNonce)();

  const binding: EngagementTokenBinding = Object.freeze({
    projectId: args.request.projectId,
    folder: args.folder,
    access,
    principalId: args.principalId,
    issuedAtIso,
    expiresAtIso,
    nonce,
  });
  args.deps.store.put(tokenString, binding);

  const envelope: EngagementTokenEnvelope = Object.freeze({
    token: tokenString,
    projectId: args.request.projectId,
    folder: args.folder,
    access,
    principalId: args.principalId,
    issuedAtIso,
    expiresAtIso,
  });

  let capabilityToken: CapabilityEngagementToken;
  try {
    capabilityToken = mintCapabilityToken(
      args.decision,
      args.adapterRequest,
      args.decision.expiresInSeconds,
      envelope,
      {
        ...(args.deps.generateTokenId !== undefined
          ? { generateTokenId: args.deps.generateTokenId }
          : {}),
        clock: () => args.now,
        engineName: args.deps.engineName ?? 'static',
      },
    );
    // T-147 — sibling capability-claims store. When provided, persist
    // the minted capability token keyed by the same opaque token bytes
    // so the gate can resolve it later without disturbing the legacy
    // `EngagementStore` binding shape. When absent, the capability
    // gate (default OFF) cannot enforce; the legacy gate is unaffected.
    if (args.deps.capabilityClaimsStore !== undefined) {
      args.deps.capabilityClaimsStore.put(tokenString, capabilityToken);
    }
  } catch (err) {
    if (err instanceof CapabilityTokenError) {
      return {
        kind: 'deny',
        projectId: args.request.projectId,
        folder: args.folder,
        principalId: args.principalId,
        access: 'none',
        reason: `mint_error: ${err.kind}`,
        decisionId: args.decision.decisionId,
        policyVersion: args.decision.policyVersion,
      };
    }
    throw err;
  }

  return {
    kind: 'allow',
    projectId: args.request.projectId,
    folder: args.folder,
    access,
    principalId: args.principalId,
    resolution: args.resolutionKind,
    matchedRule: args.matchedRule,
    engagement: envelope,
    capabilityToken,
    capabilities: args.decision.capabilities,
    decisionId: args.decision.decisionId,
    policyVersion: args.decision.policyVersion,
    ...(args.decision.grantIds !== undefined
      ? { grantIds: [...args.decision.grantIds] }
      : {}),
    source: args.decision.source,
    expiresInSeconds: args.decision.expiresInSeconds,
  };
}

function defaultToken(): string {
  return randomBytes(DEFAULT_ENGAGEMENT_TOKEN_BYTES).toString('hex');
}

function defaultNonce(): string {
  return randomBytes(DEFAULT_ENGAGEMENT_NONCE_BYTES).toString('hex');
}
