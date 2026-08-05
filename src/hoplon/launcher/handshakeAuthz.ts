/**
 * launcher/handshakeAuthz.ts — adapter-backed project handshake (T-146).
 *
 * `/projects/handshake` (HTTP), `projects_handshake` (MCP), and
 * `hoplon project handshake` (CLI) route their requests through this
 * function so that an injected `AuthorizationAdapter` decides outcome,
 * scope, and TTL. The legacy synchronous `issueProjectHandshake` in
 * `handshake.ts` remains for renewal and existing internal call sites.
 *
 * Default behavior (per T-142 review):
 *   - Default adapter is `StaticAuthorizationAdapter` built from the
 *     project's `FolderPolicy`. Existing legacy semantics preserved.
 *   - `OpaAuthorizationAdapter` is **NOT** wired here. Callers may
 *     override via `deps.adapter`.
 *
 * Outcome → response mapping is documented on `HandshakeAuthzResult`
 * (in `handshakeAuthzTypes.ts`).
 *
 * Phalanx and downstream callers MUST switch on `kind` to pick a code
 * path. Checking only `engagement` presence treats escalation /
 * approval as a soft deny and silently bypasses policy.
 *
 * Pure helper / mapper code lives in `handshakeAuthzInternals.ts` so
 * this file remains under the 300-line architecture cap.
 */
import type { FolderPolicy } from '../concurrency/projectPolicy.js';
import { resolveFolderAccess } from '../concurrency/projectPolicy.js';
import { StaticAuthorizationAdapter } from '../authorization/staticAuthorizationAdapter.js';
import type { HoplonAuthorizationDecision } from '../authorization/authorizationAdapter.js';
import {
  HandshakeError,
  normalizeHandshakeFolder,
  type HandshakeMatchedRuleSummary,
  type HandshakeRequest,
} from './handshake.js';
import {
  buildAdapterRequest,
  canonicalizeOrRaw,
  errMessage,
  normalizePrincipalId,
  randomNonce,
} from './handshakeAuthzInternals.js';
import { mapDecisionToResult } from './handshakeAuthzMap.js';
import type {
  HandshakeAuthzResult,
  IssueHandshakeViaAdapterDeps,
} from './handshakeAuthzTypes.js';

export {
  DEFAULT_HANDSHAKE_BRANCH,
  DEFAULT_HANDSHAKE_ENVIRONMENT,
  legacyAccessFromCapabilities,
} from './handshakeAuthzTypes.js';
export type {
  HandshakeAuthzResult,
  IssueHandshakeViaAdapterDeps,
} from './handshakeAuthzTypes.js';

/**
 * Issue a project handshake through the authorization-adapter seam.
 *
 * Behavior:
 *   1. Resolve the registered project + folder policy. Throws
 *      `HandshakeError` for the existing legacy pre-conditions
 *      (`unknown_project`, `no_folder_policy`, `unknown_principal`,
 *      `invalid_request`). Adapter-level authorization is consulted
 *      **only after** these pre-conditions pass.
 *   2. Build the typed `HoplonAuthorizationRequest` from the existing
 *      input plus the dependency-injected context (session id, task
 *      id, environment, branch, capabilities, clock).
 *   3. Call `adapter.evaluateAccess(request)`. Adapter exceptions
 *      become a typed `deny` result (fail-closed).
 *   4. Switch on the decision outcome:
 *      - `allow`               → mint `CapabilityEngagementToken` and
 *                                store the base binding.
 *      - `requires_escalation` → typed escalation result. **No mint.**
 *      - `requires_approval`   → typed approval result. **No mint.**
 *      - `deny`                → typed deny result. **No mint.**
 */
export async function issueProjectHandshakeViaAdapter(
  request: HandshakeRequest,
  deps: IssueHandshakeViaAdapterDeps,
): Promise<HandshakeAuthzResult> {
  // ── Pre-condition validation: identical to the legacy static path. ──
  if (
    typeof request.projectId !== 'string' ||
    request.projectId.length === 0
  ) {
    throw new HandshakeError(
      'invalid_request',
      'Handshake requires a non-empty projectId',
    );
  }
  const project = deps.registry.get(request.projectId);
  if (!project) {
    throw new HandshakeError(
      'unknown_project',
      `No project registered with id '${request.projectId}'`,
      { projectId: request.projectId },
    );
  }
  const folderPolicy: FolderPolicy | undefined = project.policy.folderPolicy;
  if (!folderPolicy) {
    throw new HandshakeError(
      'no_folder_policy',
      `Project '${request.projectId}' has no folder-scoped policy; register the project with a --folder-policy-file first`,
      { projectId: request.projectId },
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
        { projectId: request.projectId },
      );
    }
  }

  // ── Folder shape pre-validation. ──
  // Run `resolveFolderAccess` to surface invalid-folder errors with the
  // existing typed reason BEFORE the adapter is consulted. Adapter-level
  // authorization treats malformed folder shapes as denies, but legacy
  // callers expect a typed `HandshakeError(invalid_folder)` with the
  // canonicalizer's reason. We also harvest the canonical folder and
  // resolution provenance (matchedRuleIndex / matchedRuleFolder) here so
  // the legacy response carries `resolution: 'matched' | 'default_fallback'`
  // and `matchedRule`.
  const folder = normalizeHandshakeFolder(request.folder);
  const folderResolution = resolveFolderAccess(
    folderPolicy,
    folder,
    principalId ?? undefined,
  );
  if (folderResolution.kind === 'invalid_folder') {
    throw new HandshakeError(
      'invalid_folder',
      `folder '${String(request.folder)}' rejected by canonicalization: ${folderResolution.reason}`,
      { projectId: request.projectId, reason: folderResolution.reason },
    );
  }
  const canonicalFolder = folderResolution.canonicalFolder;
  const resolutionKind = folderResolution.kind;
  const matchedRule: HandshakeMatchedRuleSummary | null =
    folderResolution.kind === 'matched'
      ? {
          folder: folderResolution.matchedRuleFolder,
          index: folderResolution.matchedRuleIndex,
        }
      : null;

  // ── Build the typed adapter request. ──
  const clock = deps.clock ?? (() => new Date());
  const now = clock();
  const adapterRequest = buildAdapterRequest({
    request: { ...request, folder: canonicalFolder },
    principalId,
    deps,
    nowIso: now.toISOString(),
  });

  // ── Pick the adapter. Default = StaticAuthorizationAdapter. ──
  const adapter =
    deps.adapter ?? new StaticAuthorizationAdapter({ folderPolicy });

  // ── Evaluate. Fail-closed on thrown errors. ──
  let decision: HoplonAuthorizationDecision;
  try {
    decision = await adapter.evaluateAccess(adapterRequest);
  } catch (err) {
    return {
      kind: 'deny',
      projectId: request.projectId,
      folder: canonicalFolder,
      principalId,
      access: 'none',
      reason: `adapter_error: ${errMessage(err)}`,
      decisionId: `adapter-error-${randomNonce()}`,
      policyVersion: 'adapter-error',
    };
  }

  return mapDecisionToResult({
    request: { ...request, folder: canonicalFolder },
    decision,
    adapterRequest,
    deps,
    principalId,
    now,
    resolutionKind,
    matchedRule,
  });
}

// canonicalizeOrRaw is still needed for the very rare case where we
// build a deny envelope before folder pre-validation runs. Re-export to
// keep call-site shape unchanged.
void canonicalizeOrRaw;
