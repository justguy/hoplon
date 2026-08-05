/**
 * launcher/handshakeAuthzTypes.ts — shared types for the T-146 dynamic
 * authorization handshake seam.
 *
 * Kept in a sibling file so `handshakeAuthz.ts` stays under the
 * 300-line architecture cap.
 */
import type {
  AccessMode,
  EngagementTokenEnvelope,
} from '../concurrency/projectPolicy.js';
import type { ProjectRegistry } from '../concurrency/projectRegistry.js';
import type {
  AuthorizationAdapter,
  TokenCapabilities,
} from '../authorization/authorizationAdapter.js';
import type {
  CapabilityEngagementToken,
} from '../authorization/capabilityToken.js';
import type { CapabilityClaimsStore } from '../authorization/capabilityClaimsStore.js';
import type { HandshakeResult } from './handshake.js';
import type { EngagementStore } from './engagementStore.js';

/**
 * Default branch used when the legacy handshake input does not carry a
 * branch field. Aligns with the wildcard scope claim shape returned by
 * `StaticAuthorizationAdapter`.
 */
export const DEFAULT_HANDSHAKE_BRANCH = '**';

/**
 * Default environment used when the launcher does not supply one. Only
 * `dev` / `staging` / `prod` are accepted by `HoplonAuthorizationRequest`.
 */
export const DEFAULT_HANDSHAKE_ENVIRONMENT: 'dev' = 'dev';

/**
 * Typed outcome of `issueProjectHandshakeViaAdapter`. Always includes
 * `decisionId` + `policyVersion` for audit correlation. The legacy
 * `access` field (`read_only` / `read_write` / `none`) is derived for
 * backward compatibility on `allow` and `deny` outcomes; escalation /
 * approval outcomes do **not** populate `access` and force callers to
 * adopt the new typed shape.
 */
export type HandshakeAuthzResult =
  | {
      readonly kind: 'allow';
      readonly projectId: string;
      readonly folder: string;
      /** Legacy backward-compat access: derived from capabilities. */
      readonly access: Exclude<AccessMode, 'none'>;
      readonly principalId: string | null;
      readonly resolution: HandshakeResult['resolution'];
      readonly matchedRule: HandshakeResult['matchedRule'];
      readonly engagement: EngagementTokenEnvelope;
      /** Capability-scoped token claims (T-144 envelope). */
      readonly capabilityToken: CapabilityEngagementToken;
      readonly capabilities: TokenCapabilities;
      readonly decisionId: string;
      readonly policyVersion: string;
      readonly grantIds?: ReadonlyArray<string>;
      readonly source: 'standing_policy' | 'escalation_grant' | 'break_glass';
      readonly expiresInSeconds: number;
    }
  | {
      readonly kind: 'requires_escalation';
      readonly projectId: string;
      readonly folder: string;
      readonly principalId: string | null;
      readonly escalationKind:
        | 'self_service'
        | 'cto_approval'
        | 'human_approval'
        | 'security_approval'
        | 'platform_approval'
        | 'dba_approval';
      readonly requestedScope: TokenCapabilities;
      readonly reason: string;
      readonly decisionId: string;
      readonly policyVersion: string;
    }
  | {
      readonly kind: 'requires_approval';
      readonly projectId: string;
      readonly folder: string;
      readonly principalId: string | null;
      readonly escalationKind:
        | 'human_approval'
        | 'security_approval'
        | 'platform_approval'
        | 'dba_approval';
      readonly requestedScope: TokenCapabilities;
      readonly reason: string;
      readonly decisionId: string;
      readonly policyVersion: string;
    }
  | {
      readonly kind: 'deny';
      readonly projectId: string;
      readonly folder: string;
      readonly principalId: string | null;
      /** Legacy backward-compat access. Always `'none'` on deny. */
      readonly access: 'none';
      readonly reason: string;
      readonly decisionId: string;
      readonly policyVersion: string;
    };

/**
 * Dependencies for `issueProjectHandshakeViaAdapter`. The `adapter`
 * field is the dynamic-authz selection seam: when omitted, a fresh
 * `StaticAuthorizationAdapter` is built from the project's folder
 * policy at call time. `OpaAuthorizationAdapter` is **NOT** the default
 * (per T-142 review).
 */
export interface IssueHandshakeViaAdapterDeps {
  readonly registry: Pick<ProjectRegistry, 'get'>;
  readonly store: EngagementStore;
  readonly adapter?: AuthorizationAdapter;
  readonly clock?: () => Date;
  readonly randomToken?: () => string;
  readonly randomNonce?: () => string;
  readonly generateTokenId?: () => string;
  readonly sessionId?: string;
  readonly taskId?: string;
  readonly branch?: string;
  readonly environment?: 'dev' | 'staging' | 'prod';
  readonly requestedCapabilities?: ReadonlyArray<
    'read' | 'search' | 'write' | 'lock' | 'snapshot'
  >;
  readonly paths?: ReadonlyArray<string>;
  readonly astSelectors?: ReadonlyArray<string>;
  readonly astNodeIds?: ReadonlyArray<string>;
  readonly reason?: string;
  readonly principalType?: 'agent' | 'human' | 'service';
  readonly principalRoles?: ReadonlyArray<string>;
  /**
   * Engine name embedded in capability-token `PolicyEvidence`. Defaults
   * to `'static'` for the legacy static path; OPA injections supply
   * their own.
   */
  readonly engineName?: string;
  /**
   * T-147 sibling store for capability claims. When supplied, each
   * `allow` outcome additionally writes its `CapabilityEngagementToken`
   * keyed by the same opaque `engagement.token` bytes so the capability
   * gate can resolve it without changing the legacy `EngagementStore`
   * binding shape (T-147 retrieval option B).
   *
   * Optional. Default: undefined → no capability-claims storage; the
   * capability gate will fail-closed at enforce time.
   */
  readonly capabilityClaimsStore?: CapabilityClaimsStore;
}

/**
 * Derive the legacy `AccessMode` shim from a capability map. T-146 must
 * preserve the existing `access: 'read_only' | 'read_write'` field on
 * the response envelope so legacy clients continue to compile.
 *
 * Rule:
 *   - capabilities.write present       → `read_write`
 *   - capabilities.read OR search only → `read_only`
 *   - neither read nor search          → `none` (caller will fail-closed)
 */
export function legacyAccessFromCapabilities(
  capabilities: TokenCapabilities,
): AccessMode {
  if (capabilities.write !== undefined) return 'read_write';
  if (capabilities.read !== undefined || capabilities.search !== undefined) {
    return 'read_only';
  }
  return 'none';
}
