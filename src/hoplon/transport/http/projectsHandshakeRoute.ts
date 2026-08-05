/**
 * transport/http/projectsHandshakeRoute.ts — `POST /projects/handshake`.
 *
 * **T-146:** routes through `issueProjectHandshakeViaAdapter` so all
 * authorization decisions flow through the injected
 * `AuthorizationAdapter` seam. Default adapter is
 * `StaticAuthorizationAdapter` (built from the project's folder policy
 * on each request); OPA is never the default.
 *
 * Response compatibility:
 *   - `allow`               → 200, legacy envelope additively extended
 *                             with `kind:'allow'`, `capabilityToken`,
 *                             `capabilities`, `decisionId`, `policyVersion`,
 *                             `expiresInSeconds`, `source`, `grantIds?`.
 *   - `requires_escalation` → 202, typed envelope, **no token**.
 *   - `requires_approval`   → 202, typed envelope, **no token**.
 *   - `deny`                → 403, legacy `HandshakeError(policy_denied)`
 *                             envelope, additively `{decisionId,policyVersion}`.
 */

import type { FastifyInstance, FastifyRequest, FastifyReply } from 'fastify';

import {
  HandshakeError,
  type HandshakeRequest,
} from '../../launcher/handshake.js';
import {
  issueProjectHandshakeViaAdapter,
  type HandshakeAuthzResult,
  type IssueHandshakeViaAdapterDeps,
} from '../../launcher/handshakeAuthz.js';
import type { AuthorizationAdapter } from '../../authorization/authorizationAdapter.js';
import type { EngagementStore } from '../../launcher/engagementStore.js';
import { openLauncherProjects } from '../../launcher/projects.js';
import {
  type PolicyAuditContext,
  type PolicyAuditSink,
} from '../policyAuditSink.js';
import { fallbackAuditContext, stringFromBody } from './policyAuditContext.js';
import { extendHandshakeErrorGuidance } from './projectsGuidanceErrors.js';
import {
  optionalHandshakePrincipalId,
  requireHandshakeFolder,
  requireHandshakeString,
} from './projectsHandshakeRequest.js';

/**
 * Engine name for handshake-error rows that fire BEFORE the adapter
 * runs (e.g. Zod / canonicalization errors). Adapter-error rows pull
 * their engineName from the adapter constructor; static-only deploys
 * keep `'static'`.
 */
const HANDSHAKE_AUDIT_ENGINE_NAME = 'static';

export interface RegisterHandshakeRouteOptions {
  server: FastifyInstance;
  launcherRoot: string;
  engagementStore: EngagementStore;
  policyAuditSink: PolicyAuditSink;
  policyAuditContext: (req: FastifyRequest) => PolicyAuditContext;
  toError: (err: unknown) => unknown;
  statusForError: (err: unknown) => number;
  /**
   * Optional `AuthorizationAdapter` override. When omitted, the route
   * falls back to the default `StaticAuthorizationAdapter` constructed
   * from the project's folder policy on each request. **OPA is never
   * the default** (T-142 review).
   */
  authorizationAdapter?: AuthorizationAdapter;
}

export function registerHandshakeHttpRoute(
  opts: RegisterHandshakeRouteOptions,
): void {
  const {
    server,
    launcherRoot,
    engagementStore,
    policyAuditSink,
    policyAuditContext,
    toError,
    statusForError,
    authorizationAdapter,
  } = opts;

  server.post(
    '/projects/handshake',
    async (req: FastifyRequest, reply: FastifyReply) => {
      const startMs = Date.now();
      let handshakeInput: HandshakeRequest | null = null;
      let auditContext: PolicyAuditContext | null = null;
      let registeredProjectIds: readonly string[] = [];
      try {
        const manager = openLauncherProjects(launcherRoot);
        registeredProjectIds = manager.registry.list().map((p) => p.projectId);
        const body = (req.body ?? {}) as Record<string, unknown>;
        const projectId = requireHandshakeString(body, 'projectId');
        const folder = requireHandshakeFolder(body);
        const principalId = optionalHandshakePrincipalId(body);
        handshakeInput = {
          projectId,
          folder,
          ...(principalId !== undefined ? { principalId } : {}),
        };
        auditContext = policyAuditContext(req);
        const adapterDeps: IssueHandshakeViaAdapterDeps = {
          registry: manager.registry,
          store: engagementStore,
          ...(authorizationAdapter !== undefined
            ? { adapter: authorizationAdapter }
            : {}),
        };
        const result = await issueProjectHandshakeViaAdapter(
          handshakeInput,
          adapterDeps,
        );
        await emitResponse({
          reply,
          result,
          handshakeInput,
          auditContext,
          policyAuditSink,
          startMs,
          toError,
          statusForError,
        });
      } catch (err) {
        if (err instanceof HandshakeError) {
          const fallbackInput: HandshakeRequest =
            handshakeInput ?? {
              projectId: stringFromBody(req, 'projectId') ?? 'unknown',
              folder: stringFromBody(req, 'folder') ?? '',
            };
          const ctx =
            auditContext ?? fallbackAuditContext(req, fallbackInput.projectId);
          await policyAuditSink.recordHandshakeDeny(
            ctx,
            fallbackInput,
            err,
            Date.now() - startMs,
          );
        }
        const reqProj = stringFromBody(req, 'projectId');
        const body = extendHandshakeErrorGuidance(toError(err), err, {
          ...(typeof reqProj === 'string'
            ? { requestedProjectId: reqProj }
            : {}),
          registeredProjectIds,
        });
        await reply.status(statusForError(err)).send(body);
      }
    },
  );
}

interface EmitResponseArgs {
  reply: FastifyReply;
  result: HandshakeAuthzResult;
  handshakeInput: HandshakeRequest;
  auditContext: PolicyAuditContext;
  policyAuditSink: PolicyAuditSink;
  startMs: number;
  toError: (err: unknown) => unknown;
  statusForError: (err: unknown) => number;
}

async function emitResponse(args: EmitResponseArgs): Promise<void> {
  const {
    reply,
    result,
    auditContext,
    policyAuditSink,
    startMs,
    toError,
    statusForError,
  } = args;

  // t-148 — single typed audit row per outcome via the dynamic-authz
  // mapper. Suppress the t-088 grant/deny path here so we never emit two
  // rows for the same handshake. Audit-write failure NEVER changes the
  // handshake response (best-effort invariant).
  try {
    await policyAuditSink.recordHandshakeAuthzOutcome(
      auditContext,
      result,
      HANDSHAKE_AUDIT_ENGINE_NAME,
      Date.now() - startMs,
    );
  } catch {
    /* best-effort */
  }

  if (result.kind === 'allow') {
    const envelope = legacyAllowEnvelope(result);
    await reply.status(200).send(envelope.body);
    return;
  }

  if (result.kind === 'requires_escalation' || result.kind === 'requires_approval') {
    await reply.status(202).send({
      kind: result.kind,
      projectId: result.projectId,
      folder: result.folder,
      principalId: result.principalId,
      escalationKind: result.escalationKind,
      requestedScope: result.requestedScope,
      reason: result.reason,
      decisionId: result.decisionId,
      policyVersion: result.policyVersion,
    });
    return;
  }

  // result.kind === 'deny'. Preserve the legacy 403 + HandshakeError
  // envelope used by every existing client; additively include
  // decisionId / policyVersion so dynamic-aware callers can correlate.
  const denyError = new HandshakeError('policy_denied', result.reason, {
    projectId: result.projectId,
    access: 'none',
  });
  const baseError = toError(denyError);
  const status = statusForError(denyError);
  await reply.status(status).send(extendDenyError(baseError, result));
}

function legacyAllowEnvelope(result: HandshakeAuthzResult & { kind: 'allow' }): {
  body: Record<string, unknown>;
} {
  const body: Record<string, unknown> = {
    kind: 'allow',
    projectId: result.projectId,
    folder: result.folder,
    access: result.access,
    principalId: result.principalId,
    resolution: result.resolution,
    matchedRule: result.matchedRule,
    engagement: result.engagement,
    capabilityToken: result.capabilityToken,
    capabilities: result.capabilities,
    decisionId: result.decisionId,
    policyVersion: result.policyVersion,
    source: result.source,
    expiresInSeconds: result.expiresInSeconds,
  };
  if (result.grantIds !== undefined) body['grantIds'] = result.grantIds;
  return { body };
}

function extendDenyError(
  base: unknown,
  result: HandshakeAuthzResult & { kind: 'deny' },
): unknown {
  if (base !== null && typeof base === 'object') {
    const cloned = { ...(base as Record<string, unknown>) };
    const inner = cloned['error'];
    if (inner !== null && typeof inner === 'object') {
      cloned['error'] = {
        ...(inner as Record<string, unknown>),
        decisionId: result.decisionId,
        policyVersion: result.policyVersion,
      };
    } else {
      cloned['decisionId'] = result.decisionId;
      cloned['policyVersion'] = result.policyVersion;
    }
    return cloned;
  }
  return base;
}
