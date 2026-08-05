/**
 * launcher/handshakeAuthzInternals.ts — pure helpers for
 * `handshakeAuthz.ts` (T-146).
 *
 * Adapter-request construction + tiny utility helpers. The
 * decision-to-result mapping (which is heavier) lives in
 * `handshakeAuthzMap.ts` so this file stays focused.
 */
import { randomBytes } from 'node:crypto';

import type { HoplonAuthorizationRequest } from '../authorization/authorizationAdapter.js';
import {
  HandshakeError,
  type HandshakeRequest,
} from './handshake.js';
import {
  DEFAULT_HANDSHAKE_BRANCH,
  DEFAULT_HANDSHAKE_ENVIRONMENT,
  type IssueHandshakeViaAdapterDeps,
} from './handshakeAuthzTypes.js';

// ─── Adapter request builder ───────────────────────────────────────────────

export interface BuildAdapterRequestArgs {
  readonly request: HandshakeRequest;
  readonly principalId: string | null;
  readonly deps: IssueHandshakeViaAdapterDeps;
  readonly nowIso: string;
}

export function buildAdapterRequest(
  args: BuildAdapterRequestArgs,
): HoplonAuthorizationRequest {
  const requestedCapabilities =
    args.deps.requestedCapabilities ?? defaultRequestedCapabilities();
  const paths =
    args.deps.paths !== undefined && args.deps.paths.length > 0
      ? [...args.deps.paths]
      : [args.request.folder];
  return {
    principal: {
      id: args.principalId ?? 'anonymous',
      type: args.deps.principalType ?? 'agent',
      roles:
        args.deps.principalRoles !== undefined
          ? [...args.deps.principalRoles]
          : [],
    },
    task: {
      id: args.deps.taskId ?? `handshake-${randomNonce()}`,
    },
    request: {
      projectId: args.request.projectId,
      branch: args.deps.branch ?? DEFAULT_HANDSHAKE_BRANCH,
      capabilities: [...requestedCapabilities],
      paths,
      ...(args.deps.astSelectors !== undefined
        ? { astSelectors: [...args.deps.astSelectors] }
        : {}),
      ...(args.deps.astNodeIds !== undefined
        ? { astNodeIds: [...args.deps.astNodeIds] }
        : {}),
      ...(args.deps.reason !== undefined ? { reason: args.deps.reason } : {}),
    },
    context: {
      sessionId:
        args.deps.sessionId ?? `handshake-session-${randomNonce()}`,
      environment: args.deps.environment ?? DEFAULT_HANDSHAKE_ENVIRONMENT,
      now: args.nowIso,
    },
  };
}

// ─── Helpers ───────────────────────────────────────────────────────────────

/**
 * Default capability set granted to legacy callers that did not declare
 * a capability list. The static adapter narrows by access mode anyway,
 * so requesting all five is harmless and preserves parity with the
 * pre-T-146 implicit semantics.
 */
function defaultRequestedCapabilities(): ReadonlyArray<
  'read' | 'search' | 'write' | 'lock' | 'snapshot'
> {
  return ['read', 'search', 'write', 'lock', 'snapshot'] as const;
}

export function normalizePrincipalId(raw: unknown): string | null {
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

export function randomNonce(): string {
  return randomBytes(8).toString('hex');
}

export function errMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Best-effort folder canonicalization for response shape. The adapter
 * has already validated the folder; here we just strip a trailing slash
 * so the response carries the same form as the legacy path.
 */
export function canonicalizeOrRaw(folder: string): string {
  if (typeof folder !== 'string') return '';
  if (folder === '') return '';
  if (folder.endsWith('/')) return folder.slice(0, -1);
  return folder;
}
