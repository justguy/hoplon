/**
 * launcher/projectsReport.ts — t-080 projects-report shapes + builder.
 *
 * Pulls the t-080 multi-project types and the `buildProjectsReport`
 * helper out of `status.ts` to keep that file under the 300-line
 * architecture cap. Shapes are re-exported from `status.ts` so callers
 * keep importing from one place.
 *
 * t-086 — operator-visible policy lane:
 *   - `LauncherFolderPolicySummary` (already shipped) summarizes the
 *     folder-policy *shape* without leaking folder paths or principal
 *     identifiers.
 *   - `LauncherEngagementStateSummary` (new) summarizes the *runtime*
 *     engagement state per registered project: active counts, counts by
 *     resolved access mode, soonest expiry. Counts only — no token
 *     bytes, no folder names, no principal labels reach this surface.
 *   - The builder derives engagement state from the launcher-root
 *     scoped engagement store (the same singleton HTTP / MCP / CLI
 *     handshake surfaces share). Operators see the aggregate state of
 *     *real* issued bindings, not a parallel view.
 */

import { openLauncherProjects } from './projects.js';
import type { RegisteredProject } from '../concurrency/projectRegistry.js';
import type { AccessMode } from '../concurrency/projectPolicy.js';
import { openEngagementStore } from './engagementStore.js';
import type { EngagementStore } from './engagementStore.js';

/**
 * Summary of the t-082 folder-scoped policy for a registered project.
 *
 * Never leaks raw folder paths, principal identifiers, principal
 * labels, or engagement-token nonces — counts, the explicit default
 * access mode, and the TTL are the only fields that reach operator-
 * visible surfaces.
 */
export interface LauncherFolderPolicySummary {
  defaultAccess: AccessMode;
  folderRuleCount: number;
  principalCount: number;
  engagementTokenTtlMs: number;
}

export interface LauncherProjectPolicySummary {
  revertAllowlistCount: number;
  secretPatternsCount: number;
  /** Present only when explicitly set on this registration. */
  maxFileBytes?: number;
  /** Present only when explicitly set on this registration. */
  parseTimeoutMs?: number;
  /** Present only when this registration has a folder-scoped policy. */
  folderPolicy?: LauncherFolderPolicySummary;
}

/**
 * t-086 — runtime engagement-state summary for a registered project.
 *
 * Aggregates the launcher-root engagement store contents, scoped to
 * one `projectId`. Counts only — never folder strings, principal ids,
 * or token bytes. Operators use this to diagnose live policy state
 * (how many active engagements, when the soonest one lapses) without
 * crossing into per-binding evidence (which lives in the t-088 audit
 * trail and is presented separately).
 */
export interface LauncherEngagementStateSummary {
  /** Bindings whose `expiresAtIso` is strictly in the future at `now`. */
  active: number;
  /** Subset of `active` whose resolved access is `read_only`. */
  activeReadOnly: number;
  /** Subset of `active` whose resolved access is `read_write`. */
  activeReadWrite: number;
  /**
   * Bindings still in the store but already past their expiry, or
   * carrying a malformed expiry timestamp. Pruned by
   * `pruneExpiredTokens` on the next sweep; reported here so an
   * operator can see staleness before that sweep runs.
   */
  expiredOrMalformed: number;
  /**
   * ISO-8601 timestamp of the soonest active expiry. `null` when no
   * active bindings exist for this project.
   */
  soonestExpiryIso: string | null;
}

export interface LauncherRegisteredProjectReport {
  projectId: string;
  label: string;
  fsRoot: string;
  dbPath: string;
  gitRepoDir: string;
  grammarsDir: string;
  engineId: string;
  registeredAtIso: string;
  policy: LauncherProjectPolicySummary;
  /**
   * t-086 — engagement-state aggregates over the launcher-root engagement
   * store, scoped to this `projectId`. Always present so operators can
   * distinguish "no live policy state" from "policy state not surfaced".
   */
  engagementState: LauncherEngagementStateSummary;
}

export interface LauncherProjectsReport {
  /**
   * The operator-invoked launcher workspace (what status/MCP/HTTP boot
   * against). Always present — the launcher always has a default root.
   */
  launcherRoot: string;
  /**
   * The explicit active-project pointer, or null. When null, requests that
   * omit projectId fall through to `launcherRoot` on the shipped surfaces
   * — the multi-project routing path only fires for requests that carry
   * an explicit registered projectId.
   */
  active: LauncherRegisteredProjectReport | null;
  /** Every project that has been persisted via the launcher surface. */
  registered: LauncherRegisteredProjectReport[];
  /** Absolute path of the durable projects.json for this launcher root. */
  storePath: string;
}

export interface BuildProjectsReportDeps {
  /**
   * Override the engagement store for engagement-state aggregation. Tests
   * inject a freshly built store so they can pre-seed deterministic
   * bindings; production callers leave this undefined to use the
   * launcher-root-scoped singleton (the same store HTTP/MCP/CLI
   * handshake surfaces consume).
   */
  engagementStore?: EngagementStore;
  /**
   * Override "now" for the active/expired classification. Defaults to
   * the system clock; tests pass a fixed `Date` to assert deterministic
   * `soonestExpiryIso` values without touching real time.
   */
  now?: Date;
}

/**
 * Build the t-080 projects report for a launcher root, augmented with
 * the t-086 engagement-state summary per project. Reads the durable
 * projects.json plus the launcher-root engagement store; a missing /
 * empty store yields per-project zero counts.
 */
export function buildProjectsReport(
  launcherRoot: string,
  deps: BuildProjectsReportDeps = {},
): LauncherProjectsReport {
  const manager = openLauncherProjects(launcherRoot);
  const store = deps.engagementStore ?? openEngagementStore(launcherRoot);
  const now = deps.now ?? new Date();
  const engagementByProject = aggregateEngagementByProject(store, now);
  const active = manager.getActive();
  return {
    launcherRoot,
    storePath: manager.storePath,
    active: active ? toProjectReport(active, engagementByProject) : null,
    registered: manager
      .list()
      .map((p) => toProjectReport(p, engagementByProject)),
  };
}

export function toProjectReport(
  project: RegisteredProject,
  engagementByProject: ReadonlyMap<string, LauncherEngagementStateSummary>,
): LauncherRegisteredProjectReport {
  const policy: LauncherProjectPolicySummary = {
    revertAllowlistCount: project.policy.revertAllowlist?.length ?? 0,
    secretPatternsCount: project.policy.secretPatterns?.length ?? 0,
  };
  if (project.policy.maxFileBytes !== undefined) {
    policy.maxFileBytes = project.policy.maxFileBytes;
  }
  if (project.policy.parseTimeoutMs !== undefined) {
    policy.parseTimeoutMs = project.policy.parseTimeoutMs;
  }
  if (project.policy.folderPolicy !== undefined) {
    const fp = project.policy.folderPolicy;
    policy.folderPolicy = {
      defaultAccess: fp.defaultAccess,
      folderRuleCount: fp.folderRules.length,
      principalCount: fp.principals?.length ?? 0,
      engagementTokenTtlMs: fp.engagementTokenTtlMs,
    };
  }
  return {
    projectId: project.projectId,
    label: project.label,
    fsRoot: project.fsRoot,
    dbPath: project.dbPath,
    gitRepoDir: project.gitRepoDir,
    grammarsDir: project.grammarsDir,
    engineId: project.engineId,
    registeredAtIso: project.registeredAtIso,
    policy,
    engagementState:
      engagementByProject.get(project.projectId) ?? emptyEngagementSummary(),
  };
}

function aggregateEngagementByProject(
  store: EngagementStore,
  now: Date,
): Map<string, LauncherEngagementStateSummary> {
  const nowMs = now.getTime();
  const byProject = new Map<string, LauncherEngagementStateSummary>();
  for (const [, binding] of store.entries()) {
    const summary =
      byProject.get(binding.projectId) ?? emptyEngagementSummary();
    const expiresMs = Date.parse(binding.expiresAtIso);
    const expired = !Number.isFinite(expiresMs) || nowMs >= expiresMs;
    if (expired) {
      summary.expiredOrMalformed += 1;
    } else {
      summary.active += 1;
      if (binding.access === 'read_only') summary.activeReadOnly += 1;
      else if (binding.access === 'read_write') summary.activeReadWrite += 1;
      if (
        summary.soonestExpiryIso === null ||
        binding.expiresAtIso < summary.soonestExpiryIso
      ) {
        summary.soonestExpiryIso = binding.expiresAtIso;
      }
    }
    byProject.set(binding.projectId, summary);
  }
  return byProject;
}

function emptyEngagementSummary(): LauncherEngagementStateSummary {
  return {
    active: 0,
    activeReadOnly: 0,
    activeReadWrite: 0,
    expiredOrMalformed: 0,
    soonestExpiryIso: null,
  };
}
