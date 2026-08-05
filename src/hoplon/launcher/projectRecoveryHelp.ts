/**
 * launcher/projectRecoveryHelp.ts - shared agent-facing recovery text for
 * registered-project and folder-policy failures.
 *
 * Keep this text transport-neutral. CLI, MCP, and HTTP wrap it differently,
 * but the recovery instructions should stay byte-identical.
 */

export const PROJECT_REGISTRATION_DOC =
  'docs/HOPLON_HOST_WORKFLOW.md#registered-project-flow-for-another-folder';

export function buildUnknownProjectRecoveryHelp(input: {
  readonly projectId?: string;
  readonly registeredProjectIds?: readonly string[];
}): string {
  const registeredProjectIds = [...(input.registeredProjectIds ?? [])].sort();
  const discovery =
    registeredProjectIds.length > 0
      ? `Registered project ids in this launcher are: ${registeredProjectIds.join(
          ', ',
        )}. Retry with one of those ids, or register the target folder in this same launcher root.`
      : 'This launcher has no registered projects. Register the target folder in the launcher root used by the active MCP/HTTP process.';
  const pathHint =
    input.projectId !== undefined && looksLikeFilesystemPath(input.projectId)
      ? ' projectId is a registry id, not a filesystem path.'
      : '';
  return `${discovery}${pathHint} MCP agents cannot register projects through the agent tool profile. If this agent has trusted host-shell authority, it may use the launcher CLI from the same launcher root; otherwise ask the host/operator or admin HTTP surface to register it. If CLI project show succeeds but MCP still returns unknown_project, the CLI and MCP are using different launcher roots; register in the launcher root used by MCP or restart MCP from the intended root. See ${PROJECT_REGISTRATION_DOC}.`;
}

export function buildNoFolderPolicyRecoveryHelp(projectId: string): string {
  return `Project '${projectId}' is registered, but engagement handshakes require a folderPolicy saved at registration time. MCP cannot add that policy through the agent tool profile. Create a folder-policy JSON such as {"defaultAccess":"read_only","engagementTokenTtlMs":60000,"folderRules":[{"folder":"","access":"read_only"}]}, then use the host launcher CLI in the same launcher root with --folder-policy-file <policy.json>. If this agent has trusted host-shell authority, it may run that CLI itself; otherwise ask the host/operator or admin HTTP surface. If the id already exists, unregister/re-register intentionally; Hoplon does not silently grant access without policy. See ${PROJECT_REGISTRATION_DOC}.`;
}

export function buildUnknownPrincipalRecoveryHelp(projectId: string): string {
  return `Retry without principalId, or declare that principalId in project '${projectId}' folderPolicy.principals[] and re-register the project with --folder-policy-file.`;
}

function looksLikeFilesystemPath(value: string): boolean {
  return (
    value.startsWith('/') ||
    value.startsWith('~') ||
    /^[a-zA-Z]:[\\/]/.test(value) ||
    value.includes('/') ||
    value.includes('\\')
  );
}
