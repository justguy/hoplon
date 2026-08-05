/**
 * util/projectGuidance.ts — content-safe agent recovery guidance for
 * registered-project and folder-policy surfaces.
 *
 * These helpers intentionally return identifiers, counts, tool names, and
 * operational next steps only. They never expose folder-rule paths,
 * principal labels, token bytes, or rule bodies.
 */

export type ProjectResolutionErrorKind =
  | 'unknown_project'
  | 'no_active_project'
  | 'engine_build_failed';

export interface ProjectResolutionGuidance {
  requestedProjectId?: string;
  registeredProjectIds: string[];
  projectIdLooksLikePath: boolean;
  help: string;
}

export interface ProjectPolicySurfaceGuidance {
  policySurface: {
    summary: 'read_only';
    audit: 'read_only_when_registered';
    handshake: 'issues_engagement_token_when_folder_policy_exists';
    tokenLifecycle: 'renew_revoke_prune_existing_tokens';
    mutation: 'not_exposed_by_agent_mcp';
  };
  onboarding: {
    agentMcp: 'inspect_and_handshake_only';
    hostCli: string;
    hostHttp: string;
    launcherRoot: string;
  };
  availableMcpTools: string[];
  missingMcpTools: string[];
  nextSteps: string[];
}

export function buildProjectResolutionGuidance(input: {
  kind: ProjectResolutionErrorKind;
  requestedProjectId?: string;
  registeredProjectIds: readonly string[];
}): ProjectResolutionGuidance {
  const registeredProjectIds = [...input.registeredProjectIds].sort();
  const projectIdLooksLikePath =
    input.requestedProjectId !== undefined &&
    looksLikeFilesystemPath(input.requestedProjectId);
  return {
    ...(input.requestedProjectId !== undefined
      ? { requestedProjectId: input.requestedProjectId }
      : {}),
    registeredProjectIds,
    projectIdLooksLikePath,
    help: buildProjectResolutionHelp({
      kind: input.kind,
      projectIdLooksLikePath,
      registeredProjectIds,
    }),
  };
}

export function buildProjectResolutionHelp(input: {
  kind: ProjectResolutionErrorKind;
  projectIdLooksLikePath: boolean;
  registeredProjectIds: readonly string[];
}): string {
  if (input.kind === 'no_active_project') {
    return 'Select an active project or retry with an explicit registered projectId.';
  }
  const discovery =
    input.registeredProjectIds.length > 0
      ? 'Use one of registeredProjectIds from this response; projectId is case-sensitive. If another launcher command sees the project, verify this caller uses the same launcher root.'
      : 'No projects are registered in this launcher; register the workspace before retrying.';
  const pathHelp = input.projectIdLooksLikePath
    ? ' projectId is a registered identifier, not a filesystem path.'
    : '';
  return `${discovery}${pathHelp} MCP agents cannot register projects through the agent tool profile. To add a project, use the host launcher flow from the same launcher root, e.g. hoplon project register --project-id <id> --fs-root <dir> --folder-policy-file <policy.json> when engagement-gated access is needed. If this agent has trusted host-shell authority, it may run that launcher CLI itself; otherwise ask the host/operator.`;
}

export function buildProjectPolicySurfaceGuidance(input: {
  hasFolderPolicy: boolean;
}): ProjectPolicySurfaceGuidance {
  return {
    policySurface: {
      summary: 'read_only',
      audit: 'read_only_when_registered',
      handshake: 'issues_engagement_token_when_folder_policy_exists',
      tokenLifecycle: 'renew_revoke_prune_existing_tokens',
      mutation: 'not_exposed_by_agent_mcp',
    },
    onboarding: {
      agentMcp: 'inspect_and_handshake_only',
      hostCli:
        'hoplon project register --project-id <id> --fs-root <dir> --folder-policy-file <policy.json>',
      hostHttp:
        'POST /projects/register from a host/admin or default-profile HTTP surface',
      launcherRoot:
        'Use the same launcher root that the MCP/HTTP server uses, or the new registration will not be visible there.',
    },
    availableMcpTools: [
      'projects_policy_summary',
      'projects_policy_audit',
      'projects_handshake',
      'projects_renew',
      'projects_revoke',
      'projects_prune',
    ],
    missingMcpTools: ['projects_policy_update', 'projects_policy_set'],
    nextSteps: input.hasFolderPolicy
      ? [
          'Use projects_handshake with a registered projectId and project-relative folder to request an engagement token.',
          'Use projects_policy_audit when available to inspect recent grants, denials, and reauth failures.',
          'If the policy shape is wrong, MCP cannot mutate it; use the host CLI/admin HTTP registration flow, or ask the host/operator to change it.',
        ]
      : [
          'MCP cannot register or update folder policy; if you have trusted host-shell authority, use the host CLI registration flow, otherwise ask the host/operator.',
          'Expect projects_handshake to return no_folder_policy until a folder policy exists.',
          'Use projects_policy_summary again after host-side policy configuration changes.',
        ],
  };
}

export function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  );
}
