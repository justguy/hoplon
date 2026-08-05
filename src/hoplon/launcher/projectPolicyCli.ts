/**
 * launcher/projectPolicyCli.ts — `hoplon project policy ...`
 * subcommands (t-086).
 *
 * Operator-visible policy summary surface. The CLI is human-facing;
 * structured output is the same content-safe envelope every transport
 * (HTTP / MCP) renders. Kept separate from `projectCli.ts` so the
 * dispatcher file stays under the 300-line architecture cap (mirrors
 * `projectLifecycleCli.ts`).
 *
 * Constraints (t-086):
 *   - never expose folder paths, principal labels, or token bytes
 *   - never widen non-agent read/write behavior
 *   - additive over `buildProjectsReport`; no second project-policy
 *     truth source.
 */
import {
  buildProjectsReport,
  type LauncherEngagementStateSummary,
  type LauncherProjectPolicySummary,
} from './projectsReport.js';
import type { EngagementStore } from './engagementStore.js';

export type ProjectPolicySubcommand = { kind: 'policy-show'; projectId: string };

export type ProjectPolicyOutcome =
  | { ok: true; body: ProjectPolicySummaryReport }
  | { ok: false; errorKind: 'unknown_project'; message: string };

/**
 * Operator-visible policy summary returned by `project policy show`.
 * Aggregates the static policy shape (folder rules / principal counts,
 * default access, TTL) and the runtime engagement state (active counts,
 * soonest expiry) into one content-safe envelope.
 */
export interface ProjectPolicySummaryReport {
  projectId: string;
  label: string;
  registeredAtIso: string;
  policy: LauncherProjectPolicySummary;
  engagementState: LauncherEngagementStateSummary;
}

export const PROJECT_POLICY_HELP_TEXT = `Policy subcommands (t-086):
  hoplon project policy show --project-id <id>   Print a content-safe
                                                 summary of the project's
                                                 effective folder policy
                                                 shape (default access,
                                                 rule + principal counts,
                                                 engagement-token TTL) and
                                                 the runtime engagement
                                                 state (active counts,
                                                 soonest expiry). No
                                                 folder paths, principal
                                                 labels, or token bytes
                                                 reach this surface.
`;

export function parseProjectPolicyFlags(
  rest: readonly string[],
  flags: Map<string, string | undefined>,
): ProjectPolicySubcommand | { kind: 'error'; message: string } {
  const policySub = rest[0];
  if (policySub !== 'show') {
    return {
      kind: 'error',
      message: `Unknown policy subcommand: ${String(policySub)}`,
    };
  }
  const projectId = flags.get('project-id');
  if (projectId === undefined || projectId.length === 0) {
    return { kind: 'error', message: 'policy show requires --project-id' };
  }
  return { kind: 'policy-show', projectId };
}

export interface RunProjectPolicyDeps {
  readonly launcherRoot: string;
  readonly engagementStore?: EngagementStore;
}

export function runProjectPolicyCommand(
  sub: ProjectPolicySubcommand,
  deps: RunProjectPolicyDeps,
): ProjectPolicyOutcome {
  const reportDeps =
    deps.engagementStore !== undefined
      ? { engagementStore: deps.engagementStore }
      : {};
  const report = buildProjectsReport(deps.launcherRoot, reportDeps);
  const entry = report.registered.find((p) => p.projectId === sub.projectId);
  if (!entry) {
    return {
      ok: false,
      errorKind: 'unknown_project',
      message: `No project registered with id '${sub.projectId}'`,
    };
  }
  return {
    ok: true,
    body: {
      projectId: entry.projectId,
      label: entry.label,
      registeredAtIso: entry.registeredAtIso,
      policy: entry.policy,
      engagementState: entry.engagementState,
    },
  };
}
