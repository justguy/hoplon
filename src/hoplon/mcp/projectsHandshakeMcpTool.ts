/**
 * mcp/projectsHandshakeMcpTool.ts — `projects_handshake` MCP tool
 * (T-146 dynamic-authz routing). Routes through
 * `issueProjectHandshakeViaAdapter`. Default adapter is
 * `StaticAuthorizationAdapter`; OPA is never the default.
 *
 * Response shape: see `handshakeAuthzTypes.HandshakeAuthzResult`.
 * `allow` extends the legacy `HandshakeResult` body with capability
 * fields; `deny` falls back to the legacy HandshakeError envelope.
 */
import {
  HandshakeError,
  type HandshakeRequest,
} from '../launcher/handshake.js';
import {
  issueProjectHandshakeViaAdapter,
  type HandshakeAuthzResult,
  type IssueHandshakeViaAdapterDeps,
} from '../launcher/handshakeAuthz.js';
import type { AuthorizationAdapter } from '../authorization/authorizationAdapter.js';
import type { EngagementStore } from '../launcher/engagementStore.js';
import { openLauncherProjects } from '../launcher/projects.js';
import {
  type PolicyAuditContext,
  type PolicyAuditSink,
} from '../transport/policyAuditSink.js';
import {
  toMcpErrorResult,
  type ToolCallResult,
} from './projectToolErrors.js';

const HANDSHAKE_AUDIT_ENGINE_NAME = 'static';

export type { ToolCallResult } from './projectToolErrors.js';

export interface ProjectToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export interface BuildHandshakeMcpToolOptions {
  launcherRoot: string;
  engagementStore: EngagementStore;
  policyAuditSink: PolicyAuditSink;
  resolveAuditContext: (args: Record<string, unknown>) => PolicyAuditContext;
  authorizationAdapter?: AuthorizationAdapter;
}

export function buildHandshakeMcpTool(
  opts: BuildHandshakeMcpToolOptions,
): ProjectToolDefinition {
  const {
    launcherRoot,
    engagementStore,
    policyAuditSink,
    resolveAuditContext,
    authorizationAdapter,
  } = opts;

  return {
    name: 'projects_handshake',
    description:
      'Issue an engagement-token envelope for a registered project + folder ' +
      "pair. Resolves the folder against the project's folder-scoped policy, " +
      'canonicalizes the path, and binds the token to (projectId, canonical ' +
      'folder, access mode, expiry). Returns a typed failure kind when the ' +
      'project is unknown, the folder is malformed or denied, or the ' +
      'declared principal is unknown. This does not mutate project ' +
      'registration or folder policy. A trusted local agent with host-shell ' +
      'authority may use the launcher CLI from the same launcher root: ' +
      'hoplon project register --project-id <id> --fs-root <dir> ' +
      '--folder-policy-file <policy.json>. An MCP-only agent must ask the ' +
      'host/operator or admin HTTP surface to register projects or attach ' +
      'folder policy.',
    inputSchema: {
      type: 'object',
      additionalProperties: false,
      required: ['projectId', 'folder'],
      properties: {
        projectId: {
          type: 'string',
          minLength: 1,
          description: 'Registered project id to handshake against.',
        },
        folder: {
          type: 'string',
          description:
            'Project-relative folder. Absolute paths, backslashes, ' +
            'Windows drive letters, empty segments, and ".." are rejected ' +
            'before a rule is consulted. Use "" or exact "." for the ' +
            'project root; dot segments inside non-root paths are rejected.',
        },
        principalId: {
          type: 'string',
          minLength: 1,
          description:
            "Optional principal declared in the project's folder policy.",
        },
      },
    },
    async handler(args) {
      const startMs = Date.now();
      let handshakeInput: HandshakeRequest | null = null;
      let registeredProjectIds: readonly string[] = [];
      try {
        const projectId = requireStringArg(args, 'projectId');
        const folder = requireStringArg(args, 'folder', true);
        const principalId = optionalStringArg(args, 'principalId');
        handshakeInput = {
          projectId,
          folder,
          ...(principalId !== undefined ? { principalId } : {}),
        };
        const manager = openLauncherProjects(launcherRoot);
        registeredProjectIds = manager.registry
          .list()
          .map((p) => p.projectId);
        const adapterDeps: IssueHandshakeViaAdapterDeps = {
          registry: manager.registry,
          store: engagementStore,
          ...(authorizationAdapter !== undefined
            ? { adapter: authorizationAdapter }
            : {}),
        };
        const decision = await issueProjectHandshakeViaAdapter(
          handshakeInput,
          adapterDeps,
        );
        return await emitMcpResult({
          decision,
          handshakeInput,
          auditContext: resolveAuditContext(args),
          policyAuditSink,
          startMs,
        });
      } catch (err) {
        if (err instanceof HandshakeError) {
          const denyInput: HandshakeRequest =
            handshakeInput ?? {
              projectId: safeStringArg(args, 'projectId') ?? 'unknown',
              folder: safeStringArg(args, 'folder') ?? '',
            };
          await policyAuditSink.recordHandshakeDeny(
            resolveAuditContext(args),
            denyInput,
            err,
            Date.now() - startMs,
          );
        }
        const reqProj = safeStringArg(args, 'projectId');
        return toMcpErrorResult(err, {
          ...(reqProj !== undefined ? { requestedProjectId: reqProj } : {}),
          registeredProjectIds,
        });
      }
    },
  };
}

interface EmitMcpResultArgs {
  decision: HandshakeAuthzResult;
  handshakeInput: HandshakeRequest;
  auditContext: PolicyAuditContext;
  policyAuditSink: PolicyAuditSink;
  startMs: number;
}

async function emitMcpResult(
  args: EmitMcpResultArgs,
): Promise<ToolCallResult> {
  const { decision, auditContext, policyAuditSink, startMs } = args;

  // t-148 — single typed audit row per outcome via the dynamic-authz
  // mapper. Suppress the t-088 grant/deny path here so we never emit
  // two rows for the same handshake. Audit-write failure NEVER changes
  // the response (best-effort invariant).
  try {
    await policyAuditSink.recordHandshakeAuthzOutcome(
      auditContext,
      decision,
      HANDSHAKE_AUDIT_ENGINE_NAME,
      Date.now() - startMs,
    );
  } catch {
    /* best-effort */
  }

  if (decision.kind === 'allow') {
    const body: Record<string, unknown> = {
      kind: 'allow',
      projectId: decision.projectId,
      folder: decision.folder,
      access: decision.access,
      principalId: decision.principalId,
      resolution: decision.resolution,
      matchedRule: decision.matchedRule,
      engagement: decision.engagement,
      capabilityToken: decision.capabilityToken,
      capabilities: decision.capabilities,
      decisionId: decision.decisionId,
      policyVersion: decision.policyVersion,
      source: decision.source,
      expiresInSeconds: decision.expiresInSeconds,
    };
    if (decision.grantIds !== undefined) body['grantIds'] = decision.grantIds;
    return { content: [{ type: 'text', text: JSON.stringify(body) }] };
  }

  if (
    decision.kind === 'requires_escalation' ||
    decision.kind === 'requires_approval'
  ) {
    return {
      content: [
        {
          type: 'text',
          text: JSON.stringify({
            kind: decision.kind,
            projectId: decision.projectId,
            folder: decision.folder,
            principalId: decision.principalId,
            escalationKind: decision.escalationKind,
            requestedScope: decision.requestedScope,
            reason: decision.reason,
            decisionId: decision.decisionId,
            policyVersion: decision.policyVersion,
          }),
        },
      ],
    };
  }

  // deny — translate to legacy HandshakeError(policy_denied) envelope.
  // Audit row was already emitted via recordHandshakeAuthzOutcome above.
  const denyError = new HandshakeError('policy_denied', decision.reason, {
    projectId: decision.projectId,
    access: 'none',
  });
  const errorEnvelope = toMcpErrorResult(denyError);
  if (
    Array.isArray(errorEnvelope.content) &&
    errorEnvelope.content[0] !== undefined
  ) {
    try {
      const parsed = JSON.parse(errorEnvelope.content[0].text) as Record<
        string,
        unknown
      >;
      parsed['decisionId'] = decision.decisionId;
      parsed['policyVersion'] = decision.policyVersion;
      errorEnvelope.content[0] = {
        type: 'text',
        text: JSON.stringify(parsed),
      };
    } catch {
      /* best-effort */
    }
  }
  return errorEnvelope;
}

function requireStringArg(
  args: Record<string, unknown>,
  key: string,
  allowEmpty = false,
): string {
  const value = args[key];
  if (typeof value !== 'string' || (!allowEmpty && value.length === 0)) {
    throw new HandshakeError(
      'invalid_request',
      `project tool: missing or empty '${key}' argument`,
    );
  }
  return value;
}

function optionalStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(args, key)) return undefined;
  return requireStringArg(args, key);
}

function safeStringArg(
  args: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = args[key];
  return typeof value === 'string' ? value : undefined;
}
