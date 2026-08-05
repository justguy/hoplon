/**
 * launcher/handshake.ts — single project/folder handshake + engagement-token
 * issuance for the t-083 policy lane.
 *
 * One implementation. Launcher CLI, HTTP `/projects/handshake`, and the MCP
 * `projects_handshake` tool all route here. There is no transport-specific
 * routing, no per-transport token shape, and no side-channel that bypasses
 * the registered-project boundary from t-080.
 *
 * Lifecycle scope:
 *   - This module issues engagement tokens and writes the server-private
 *     binding into the shared `EngagementStore`. Renewal, revocation, and
 *     expired-state cleanup live in `engagementLifecycle` on top of the
 *     same store so we never build per-transport caches.
 *   - The store interface and in-memory default live in `engagementStore`.
 *     They are re-exported here so existing call sites continue to work
 *     while the lifecycle split is settling in.
 *   - Failure shapes (`HandshakeError.kind`) are the contract seam every
 *     transport maps into its own error envelope.
 */
import { randomBytes } from 'node:crypto';

import { resolveFolderAccess } from '../concurrency/projectPolicy.js';
import type {
  AccessMode,
  EngagementTokenBinding,
  EngagementTokenEnvelope,
  FolderPolicy,
  InvalidFolderReason,
} from '../concurrency/projectPolicy.js';
import type { ProjectRegistry } from '../concurrency/projectRegistry.js';
import type { EngagementStore } from './engagementStore.js';
import {
  buildNoFolderPolicyRecoveryHelp,
  buildUnknownPrincipalRecoveryHelp,
  buildUnknownProjectRecoveryHelp,
} from './projectRecoveryHelp.js';

export {
  createInMemoryEngagementStore,
  openEngagementStore,
  __resetEngagementStoresForTests,
} from './engagementStore.js';
export type { EngagementStore } from './engagementStore.js';

export type HandshakeErrorKind =
  | 'invalid_request'
  | 'unknown_project'
  | 'no_folder_policy'
  | 'invalid_folder'
  | 'policy_denied'
  | 'unknown_principal';

export class HandshakeError extends Error {
  public readonly kind: HandshakeErrorKind;
  public readonly projectId?: string;
  public readonly reason?: InvalidFolderReason;
  public readonly access?: AccessMode;
  public readonly registeredProjectIds?: readonly string[];
  public readonly recoveryHelp?: string;

  constructor(
    kind: HandshakeErrorKind,
    message: string,
    extras: {
      projectId?: string;
      reason?: InvalidFolderReason;
      access?: AccessMode;
      registeredProjectIds?: readonly string[];
      recoveryHelp?: string;
    } = {},
  ) {
    super(message);
    this.name = 'HandshakeError';
    this.kind = kind;
    if (extras.projectId !== undefined) this.projectId = extras.projectId;
    if (extras.reason !== undefined) this.reason = extras.reason;
    if (extras.access !== undefined) this.access = extras.access;
    if (extras.registeredProjectIds !== undefined) {
      this.registeredProjectIds = [...extras.registeredProjectIds].sort();
    }
    if (extras.recoveryHelp !== undefined) this.recoveryHelp = extras.recoveryHelp;
  }
}

export interface HandshakeRequest {
  readonly projectId: string;
  /**
   * Project-relative folder. The empty string is the project root; exact `.`
   * is accepted as a handshake-only root alias before policy resolution.
   */
  readonly folder: string;
  readonly principalId?: string;
}

export interface HandshakeMatchedRuleSummary {
  readonly folder: string;
  readonly index: number;
}

export interface HandshakeResult {
  readonly projectId: string;
  /** Canonical project-relative folder the binding was issued for. */
  readonly folder: string;
  /** Resolved access. `none` never reaches this surface — it becomes `policy_denied`. */
  readonly access: Exclude<AccessMode, 'none'>;
  readonly principalId: string | null;
  readonly resolution: 'matched' | 'default_fallback';
  readonly matchedRule: HandshakeMatchedRuleSummary | null;
  readonly engagement: EngagementTokenEnvelope;
}

export interface IssueHandshakeDeps {
  readonly registry: Pick<ProjectRegistry, 'get' | 'list'>;
  readonly store: EngagementStore;
  readonly clock?: () => Date;
  readonly randomToken?: () => string;
  readonly randomNonce?: () => string;
}

/** Fixed opaque token length in bytes — encoded as hex → 64 chars. */
export const DEFAULT_ENGAGEMENT_TOKEN_BYTES = 32;
const DEFAULT_ENGAGEMENT_NONCE_BYTES = 16;

/**
 * Issue an engagement token for a `{ projectId, folder, principalId }`
 * handshake. Pure module (apart from injected clock + randomness) so tests
 * can assert the full envelope deterministically.
 */
export function issueProjectHandshake(
  request: HandshakeRequest,
  deps: IssueHandshakeDeps,
): HandshakeResult {
  if (typeof request.projectId !== 'string' || request.projectId.length === 0) {
    throw new HandshakeError(
      'invalid_request',
      'Handshake requires a non-empty projectId',
    );
  }
  const project = deps.registry.get(request.projectId);
  if (!project) {
    const registeredProjectIds = deps.registry.list().map((p) => p.projectId);
    throw new HandshakeError(
      'unknown_project',
      `No project registered with id '${request.projectId}'`,
      {
        projectId: request.projectId,
        registeredProjectIds,
        recoveryHelp: buildUnknownProjectRecoveryHelp({
          projectId: request.projectId,
          registeredProjectIds,
        }),
      },
    );
  }
  const folderPolicy: FolderPolicy | undefined = project.policy.folderPolicy;
  if (!folderPolicy) {
    throw new HandshakeError(
      'no_folder_policy',
      `Project '${request.projectId}' has no folder-scoped policy; register the project with a --folder-policy-file first`,
      {
        projectId: request.projectId,
        recoveryHelp: buildNoFolderPolicyRecoveryHelp(request.projectId),
      },
    );
  }

  const principalId = normalizePrincipalId(request.principalId);
  if (principalId !== null) {
    const knownPrincipals = folderPolicy.principals ?? [];
    const known = knownPrincipals.some((p) => p.principalId === principalId);
    if (!known) {
      throw new HandshakeError(
        'unknown_principal',
        `Principal '${principalId}' is not declared in the folder policy of project '${request.projectId}'`,
        {
          projectId: request.projectId,
          recoveryHelp: buildUnknownPrincipalRecoveryHelp(request.projectId),
        },
      );
    }
  }

  const folder = normalizeHandshakeFolder(request.folder);
  const resolution = resolveFolderAccess(
    folderPolicy,
    folder,
    principalId ?? undefined,
  );
  if (resolution.kind === 'invalid_folder') {
    throw new HandshakeError(
      'invalid_folder',
      `folder '${String(request.folder)}' rejected by canonicalization: ${resolution.reason}`,
      { projectId: request.projectId, reason: resolution.reason },
    );
  }
  if (resolution.access === 'none') {
    throw new HandshakeError(
      'policy_denied',
      `Access denied for folder '${resolution.canonicalFolder}' in project '${request.projectId}'`,
      { projectId: request.projectId, access: 'none' },
    );
  }

  const access = resolution.access;
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const issuedAtIso = now.toISOString();
  const expiresAtIso = new Date(
    now.getTime() + folderPolicy.engagementTokenTtlMs,
  ).toISOString();

  const nonce = (deps.randomNonce ?? defaultNonce)();
  const token = (deps.randomToken ?? defaultToken)();

  const binding: EngagementTokenBinding = Object.freeze({
    projectId: request.projectId,
    folder: resolution.canonicalFolder,
    access,
    principalId,
    issuedAtIso,
    expiresAtIso,
    nonce,
  });
  deps.store.put(token, binding);

  const envelope: EngagementTokenEnvelope = Object.freeze({
    token,
    projectId: request.projectId,
    folder: resolution.canonicalFolder,
    access,
    principalId,
    issuedAtIso,
    expiresAtIso,
  });

  const matchedRule: HandshakeMatchedRuleSummary | null =
    resolution.kind === 'matched'
      ? {
          folder: resolution.matchedRuleFolder,
          index: resolution.matchedRuleIndex,
        }
      : null;

  return Object.freeze({
    projectId: request.projectId,
    folder: resolution.canonicalFolder,
    access,
    principalId,
    resolution: resolution.kind,
    matchedRule,
    engagement: envelope,
  });
}

function normalizePrincipalId(raw: unknown): string | null {
  if (raw === undefined) return null;
  if (typeof raw !== 'string') {
    throw new HandshakeError(
      'invalid_request',
      'principalId must be a string when supplied',
    );
  }
  if (raw.length === 0) {
    throw new HandshakeError(
      'invalid_request',
      'principalId must be non-empty when supplied',
    );
  }
  return raw;
}

export function normalizeHandshakeFolder(raw: string): string {
  return raw === '.' ? '' : raw;
}

function defaultToken(): string {
  return randomBytes(DEFAULT_ENGAGEMENT_TOKEN_BYTES).toString('hex');
}

function defaultNonce(): string {
  return randomBytes(DEFAULT_ENGAGEMENT_NONCE_BYTES).toString('hex');
}
