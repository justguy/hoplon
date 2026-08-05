/**
 * strictAgentFallback.ts - typed fail-closed posture for strict-agent mode.
 *
 * Strict-agent mode is allowed to hide host/operator compatibility surfaces.
 * When an agent still attempts one of those surfaces, the transport returns
 * this typed envelope instead of recommending host raw tools.
 */

import {
  buildProjectPolicySurfaceGuidance,
  type ProjectPolicySurfaceGuidance,
} from '../util/projectGuidance.js';

export const STRICT_AGENT_FORBIDDEN_FALLBACKS = [
  'cat',
  'rg',
  'grep',
  'filesystem_mcp',
  'ide_viewer',
  'host_write_flow',
  'markEdited',
] as const;

export type StrictAgentForbiddenFallback =
  (typeof STRICT_AGENT_FORBIDDEN_FALLBACKS)[number];

export type StrictAgentFallbackErrorKind =
  | 'strict_agent_launcher_unavailable'
  | 'strict_agent_unsupported_route'
  | 'strict_agent_unsupported_tool';

export interface StrictAgentFallbackPolicy {
  mode: 'fail_closed';
  launcherUnavailable: {
    kind: 'strict_agent_launcher_unavailable';
    agentFallbackAllowed: false;
  };
  unsupportedSurface: {
    kind: 'strict_agent_unsupported_route' | 'strict_agent_unsupported_tool';
    agentFallbackAllowed: false;
  };
  forbiddenFallbacks: readonly StrictAgentForbiddenFallback[];
}

export interface StrictAgentFallbackErrorEnvelope {
  error: {
    class: 'StrictAgentFallbackError';
    kind: StrictAgentFallbackErrorKind;
    message: string;
    correlationId: string;
    details: {
      agentFallbackAllowed: false;
      compatibilityProfileFallbackAllowed: true;
      forbiddenFallbacks: readonly StrictAgentForbiddenFallback[];
      policyGuidance: ProjectPolicySurfaceGuidance;
      surface?: string;
    };
  };
}

export const HOPLON_STRICT_AGENT_FALLBACK_POLICY: StrictAgentFallbackPolicy = {
  mode: 'fail_closed',
  launcherUnavailable: {
    kind: 'strict_agent_launcher_unavailable',
    agentFallbackAllowed: false,
  },
  unsupportedSurface: {
    kind: 'strict_agent_unsupported_route',
    agentFallbackAllowed: false,
  },
  forbiddenFallbacks: STRICT_AGENT_FORBIDDEN_FALLBACKS,
};

export function strictAgentFallbackEnvelope(args: {
  kind: StrictAgentFallbackErrorKind;
  correlationId: string;
  surface?: string;
}): StrictAgentFallbackErrorEnvelope {
  return {
    error: {
      class: 'StrictAgentFallbackError',
      kind: args.kind,
      message: messageForStrictAgentFallback(args.kind),
      correlationId: args.correlationId,
      details: {
        agentFallbackAllowed: false,
        compatibilityProfileFallbackAllowed: true,
        forbiddenFallbacks: STRICT_AGENT_FORBIDDEN_FALLBACKS,
        policyGuidance: buildProjectPolicySurfaceGuidance({
          hasFolderPolicy: false,
        }),
        ...(args.surface !== undefined ? { surface: args.surface } : {}),
      },
    },
  };
}

export function strictAgentFallbackHttpResponse(args: {
  kind: StrictAgentFallbackErrorKind;
  correlationId: string;
  surface?: string;
}): { status: number; body: StrictAgentFallbackErrorEnvelope } {
  return {
    status: args.kind === 'strict_agent_launcher_unavailable' ? 503 : 403,
    body: strictAgentFallbackEnvelope(args),
  };
}

export function strictAgentHiddenHttpSurface(args: {
  method: string;
  url: string;
}): string | null {
  const path = args.url.split('?')[0] ?? args.url;
  const key = `${args.method.toUpperCase()} ${path}`;
  return STRICT_AGENT_HIDDEN_HTTP_ROUTES.get(key) ?? null;
}

function messageForStrictAgentFallback(
  kind: StrictAgentFallbackErrorKind,
): string {
  switch (kind) {
    case 'strict_agent_launcher_unavailable':
      return 'Strict-agent Hoplon launcher is unavailable; strict mode fails closed.';
    case 'strict_agent_unsupported_route':
      return 'Strict-agent profile does not expose this HTTP route.';
    case 'strict_agent_unsupported_tool':
      return 'Strict-agent profile does not expose this MCP tool.';
  }
}

const STRICT_AGENT_HIDDEN_HTTP_ROUTES = new Map<string, string>([
  ['POST /packContext', '/packContext'],
  ['POST /queryStructure', '/queryStructure'],
  ['POST /extractStructuralTemplate', '/extractStructuralTemplate'],
  ['POST /session/markEdited', '/session/markEdited'],
  ['POST /session/quickEdit', '/session/quickEdit'],
  ['GET /projects', '/projects'],
  ['POST /projects/register', '/projects/register'],
  ['POST /projects/unregister', '/projects/unregister'],
  ['POST /projects/select', '/projects/select'],
  ['POST /projects/clear-active', '/projects/clear-active'],
]);
