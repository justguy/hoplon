/**
 * launcher/projectCli.ts — CLI parser + runner for `hoplon project ...`.
 *
 * Operates on `<root>/.hoplon/projects.json` via `openLauncherProjects`.
 * Transport-agnostic: `parseProjectCommand` returns a plan that
 * `runProjectCommand` executes. Lifecycle (t-084) and policy-summary
 * (t-086) subcommands delegate to sibling modules so this dispatcher
 * stays under the 300-line architecture cap.
 */

import { openLauncherProjects, LauncherProjectsError } from './projects.js';
import { buildProjectsReport } from './projectsReport.js';
import type { LauncherWorkspaceInput } from './config.js';
import { resolveLauncherWorkspace } from './config.js';
import type { FolderPolicy } from '../concurrency/projectPolicy.js';
import {
  HandshakeError,
  issueProjectHandshake,
} from './handshake.js';
import { openEngagementStore } from './engagementStore.js';
import type { EngagementStore } from './engagementStore.js';
import { collectFlags, loadFolderPolicyFile } from './projectCliHelpers.js';
import {
  parseProjectLifecycleFlags,
  runProjectLifecycleCommand,
} from './projectLifecycleCli.js';
import type { ProjectLifecycleSubcommand } from './projectLifecycleCli.js';
import {
  parseProjectPolicyFlags,
  runProjectPolicyCommand,
} from './projectPolicyCli.js';
import type { ProjectPolicySubcommand } from './projectPolicyCli.js';
export { PROJECT_HELP_TEXT } from './projectHelpText.js';

export type ProjectSubcommand =
  | { kind: 'list' }
  | { kind: 'clear-active' }
  | {
      kind: 'register';
      projectId: string;
      fsRoot: string;
      label?: string;
      engineId?: string;
      gitRepoDir?: string;
      grammarsDir?: string;
      dbPath?: string;
      /**
       * Optional path to a JSON file describing the t-082 folder-scoped
       * policy for this project. Shape matches `FolderPolicy` as
       * serialized by `projectsPolicySchema`. When absent, the
       * registered project has no folder-scoped policy.
       */
      folderPolicyFile?: string;
    }
  | { kind: 'unregister'; projectId: string }
  | { kind: 'select'; projectId: string }
  | { kind: 'show'; projectId: string }
  | {
      kind: 'handshake';
      projectId: string;
      folder: string;
      principalId?: string;
    }
  | ProjectPolicySubcommand
  | ProjectLifecycleSubcommand;

export type ProjectCommandOutcome =
  | { ok: true; body: unknown }
  | { ok: false; errorKind: string; message: string };

/**
 * Parse a `hoplon project ...` argv tail (after the leading `project` token).
 * Returns either a structured subcommand or an error message.
 */
export function parseProjectCommand(
  argv: readonly string[],
): { kind: 'help' } | ProjectSubcommand | { kind: 'error'; message: string } {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { kind: 'help' };
  }
  const [sub, ...rest] = argv;
  const flags = collectFlags(rest);

  if (sub === 'list') return { kind: 'list' };
  if (sub === 'clear-active') return { kind: 'clear-active' };

  const projectId = flags.get('project-id');
  if (sub === 'register') {
    const fsRoot = flags.get('fs-root');
    if (!projectId) {
      return { kind: 'error', message: 'register requires --project-id' };
    }
    if (!fsRoot) {
      return { kind: 'error', message: 'register requires --fs-root' };
    }
    const plan: ProjectSubcommand = { kind: 'register', projectId, fsRoot };
    const label = flags.get('label');
    if (label) plan.label = label;
    const engineId = flags.get('engine-id');
    if (engineId) plan.engineId = engineId;
    const gitRepoDir = flags.get('git-repo-dir');
    if (gitRepoDir) plan.gitRepoDir = gitRepoDir;
    const grammarsDir = flags.get('grammars-dir');
    if (grammarsDir) plan.grammarsDir = grammarsDir;
    const dbPath = flags.get('db-path');
    if (dbPath) plan.dbPath = dbPath;
    const folderPolicyFile = flags.get('folder-policy-file');
    if (folderPolicyFile) plan.folderPolicyFile = folderPolicyFile;
    return plan;
  }

  if (sub === 'unregister' || sub === 'select' || sub === 'show') {
    if (!projectId) {
      return { kind: 'error', message: `${sub} requires --project-id` };
    }
    return { kind: sub, projectId };
  }

  if (sub === 'policy') {
    return parseProjectPolicyFlags(rest, flags);
  }

  if (sub === 'handshake') {
    if (!projectId) {
      return { kind: 'error', message: 'handshake requires --project-id' };
    }
    const folder = flags.get('folder');
    if (folder === undefined) {
      return { kind: 'error', message: 'handshake requires --folder' };
    }
    const plan: ProjectSubcommand = {
      kind: 'handshake',
      projectId,
      folder,
    };
    if (flags.has('principal-id')) {
      const principalId = flags.get('principal-id');
      if (principalId === undefined || principalId.length === 0) {
        return { kind: 'error', message: 'handshake requires non-empty --principal-id' };
      }
      plan.principalId = principalId;
    }
    return plan;
  }

  if (sub === 'renew' || sub === 'revoke' || sub === 'prune') {
    return parseProjectLifecycleFlags(sub, flags);
  }

  return { kind: 'error', message: `Unknown project subcommand: ${String(sub)}` };
}
/**
 * Execute a parsed `project` subcommand against a launcher root. Returns
 * `{ ok, body | errorKind + message }` for transport-agnostic rendering.
 *
 * **T-146 — CLI compatibility note:** the `handshake` subcommand
 * continues to call the legacy synchronous `issueProjectHandshake` and
 * returns the legacy `HandshakeResult` shape so existing CLI scripts
 * are unchanged. The synchronous path is functionally equivalent to
 * routing through `StaticAuthorizationAdapter` (the static adapter
 * wraps the same `resolveFolderAccess`), so allow / deny / fallback
 * semantics are identical. CLI consumers who need the dynamic typed
 * shape (with `kind`, `capabilities`, `decisionId`, `policyVersion`)
 * should call `issueProjectHandshakeViaAdapter` directly through the
 * launcher API.
 */
export function runProjectCommand(
  input: LauncherWorkspaceInput,
  sub: ProjectSubcommand,
  deps: { engagementStore?: EngagementStore } = {},
): ProjectCommandOutcome {
  const workspace = resolveLauncherWorkspace(input);
  try {
    const manager = openLauncherProjects(workspace.root);
    const reportDeps = deps.engagementStore
      ? { engagementStore: deps.engagementStore }
      : {};
    if (sub.kind === 'list') {
      return { ok: true, body: buildProjectsReport(workspace.root, reportDeps) };
    }
    if (sub.kind === 'show') {
      const project = manager.get(sub.projectId);
      return project
        ? { ok: true, body: project }
        : { ok: false, errorKind: 'unknown_project', message: `No project registered with id '${sub.projectId}'` };
    }
    if (sub.kind === 'policy-show') {
      const outcome = runProjectPolicyCommand(sub, {
        launcherRoot: workspace.root,
        ...reportDeps,
      });
      return outcome.ok
        ? { ok: true, body: outcome.body }
        : { ok: false, errorKind: outcome.errorKind, message: outcome.message };
    }
    if (sub.kind === 'clear-active') {
      manager.clearActive();
      return { ok: true, body: { cleared: true } };
    }
    if (sub.kind === 'register') {
      let folderPolicy: FolderPolicy | undefined;
      if (sub.folderPolicyFile !== undefined) {
        const loaded = loadFolderPolicyFile(sub.folderPolicyFile);
        if (!loaded.ok) return loaded;
        folderPolicy = loaded.policy;
      }
      const policy = folderPolicy !== undefined ? { folderPolicy } : {};
      const record = manager.register({
        projectId: sub.projectId,
        fsRoot: sub.fsRoot,
        ...(sub.label !== undefined ? { label: sub.label } : {}),
        ...(sub.engineId !== undefined ? { engineId: sub.engineId } : {}),
        ...(sub.gitRepoDir !== undefined ? { gitRepoDir: sub.gitRepoDir } : {}),
        ...(sub.grammarsDir !== undefined ? { grammarsDir: sub.grammarsDir } : {}),
        ...(sub.dbPath !== undefined ? { dbPath: sub.dbPath } : {}),
        policy,
      });
      return { ok: true, body: record };
    }
    if (sub.kind === 'unregister') {
      manager.unregister(sub.projectId);
      return { ok: true, body: { unregistered: sub.projectId } };
    }
    if (sub.kind === 'select') {
      manager.setActive(sub.projectId);
      return { ok: true, body: { active: sub.projectId } };
    }
    if (sub.kind === 'handshake') {
      const store = deps.engagementStore ?? openEngagementStore(workspace.root);
      const handshakeInput: Parameters<typeof issueProjectHandshake>[0] = {
        projectId: sub.projectId,
        folder: sub.folder,
        ...(sub.principalId !== undefined
          ? { principalId: sub.principalId }
          : {}),
      };
      const result = issueProjectHandshake(handshakeInput, {
        registry: manager.registry,
        store,
      });
      return { ok: true, body: result };
    }
    if (sub.kind === 'renew' || sub.kind === 'revoke' || sub.kind === 'prune') {
      const store = deps.engagementStore ?? openEngagementStore(workspace.root);
      return runProjectLifecycleCommand(sub, {
        store,
        registry: manager.registry,
      });
    }
    return {
      ok: false,
      errorKind: 'unknown_subcommand',
      message: `Unknown project subcommand: ${(sub as { kind: string }).kind}`,
    };
  } catch (err) {
    if (err instanceof LauncherProjectsError) {
      return { ok: false, errorKind: err.kind, message: err.message };
    }
    if (err instanceof HandshakeError) {
      const help = err.recoveryHelp === undefined ? '' : ` Help: ${err.recoveryHelp}`;
      return { ok: false, errorKind: err.kind, message: `${err.message}${help}` };
    }
    return {
      ok: false,
      errorKind: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    };
  }
}
