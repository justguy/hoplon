/**
 * launcher/status.ts — `hoplon status` implementation.
 *
 * Reports launcher truth for the current workspace: resolved paths, engine
 * identity, adapter presence (via engine.health()), and which packaged
 * MCP + HTTP surfaces this launcher can expose.
 *
 * Honest reporting discipline:
 *   - every field describes a truth that is *currently* observable
 *   - adapter names come from engine.health(), never fabricated
 *   - missing/degraded capabilities are reported as-is, never silently healed
 *   - no retry/escalation logic lives here (H4)
 */

import * as fs from 'node:fs';
import { resolveLauncherWorkspace, ensureWorkspaceLayout } from './config.js';
import type { LauncherWorkspaceConfig, LauncherWorkspaceInput } from './config.js';
import { createDefaultHoplonEngine } from '../engine/factory.js';
import type { SemanticRuntimeAdapters } from '../engine/factory.js';
import type { CapabilityContractReport } from '../contracts/capabilities.js';
import type { EngineHealth } from '../contracts/health.js';
import {
  HOPLON_LIVE_USE_DEFAULTS,
  type LiveUseDefaultsReport,
} from './liveUseDefaults.js';
import {
  buildProjectsReport,
  type LauncherProjectsReport,
} from './projectsReport.js';
import {
  buildSafeEditCapabilityReport,
  type SafeEditCapabilityReport,
} from './safeEditStatus.js';

export { HOPLON_LIVE_USE_DEFAULTS } from './liveUseDefaults.js';
export type { LiveUseDefaultsReport } from './liveUseDefaults.js';
export type {
  LauncherProjectsReport,
  LauncherRegisteredProjectReport,
  LauncherProjectPolicySummary,
  LauncherFolderPolicySummary,
  LauncherEngagementStateSummary,
} from './projectsReport.js';
export type {
  SafeEditCapabilityReport,
  SafeEditLockTopologyReport,
} from './safeEditStatus.js';

export interface LauncherCapabilityReport {
  name: string;
  status: 'available' | 'degraded' | 'unavailable';
}

/**
 * Operator-facing description of the one supported live-usage composition.
 *
 * This is the `t-057` Live Usage Bundle (Lane F, LU-1): the explicit
 * "use Hoplon now" stack for an operator or agent. It names:
 *
 *   - The Hoplon-owned structural + supervised-edit surfaces that are already
 *     materially shipped on this branch.
 *   - The companion raw-text/file access that the bundle still requires but
 *     that Hoplon does not ship. After `t-075`, `hoplon query see` /
 *     `engine.seeCodebase` are authoritative for supported non-binary code
 *     reads and raw text search on code scopes, so the host companion is now
 *     narrowed to non-code repo text, binary content, and the
 *     launcher-unavailable operational case. That companion stays host-owned
 *     and compositional on purpose.
 *
 * The bundle is a truth handshake, not a new runtime mechanism. `runStatus()`
 * does not start the bundle, negotiate with it, or probe the raw-text
 * companion. It only reports that the launcher, query, and session surfaces
 * below are the supported operator-facing composition.
 */
export interface LiveUsageBundleReport {
  /** Stable operator-facing name for docs + tracker truth. */
  name: 'hoplon-live-usage-bundle';
  /** Hoplon-owned surfaces that make up the structural/edit half of the bundle. */
  hoplonSurfaces: {
    launcherCommands: readonly [
      'hoplon status',
      'hoplon mcp serve',
      'hoplon http serve',
    ];
    queryCommands: readonly [
      'hoplon query capabilities',
      'hoplon query skeleton',
      'hoplon query structure',
      'hoplon query search',
      'hoplon query project',
      'hoplon query see',
    ];
    /** The only supported supervised edit loop; see `src/hoplon/session/`. */
    editSessionEntry: 'createHoplonEditSession';
  };
  /**
   * Companion raw-text / file access the bundle requires. Host-owned on
   * purpose; Hoplon does not ship a raw-text grep surface or a generic file
   * reader, and `query search` / `query project` are not substitutes.
   */
  rawTextCompanion: {
    owner: 'host';
    /** What this companion is explicitly needed for. */
    coverage: readonly [
      'docs',
      'configs',
      'env files',
      'logs',
      'binary content',
      'launcher unavailable',
    ];
  };
}

export interface LauncherStatusReport {
  version: 1;
  workspace: LauncherWorkspaceConfig;
  engineId: string;
  health: EngineHealth;
  grammarsPresent: boolean;
  capabilities: LauncherCapabilityReport[];
  extensionCapabilities: CapabilityContractReport[];
  /** Packaged launcher surfaces supported by this binary; not live probes. */
  surfaces: {
    mcp: 'available';
    http: 'available';
  };
  /**
   * The supported live-usage composition (`t-057` / Lane F LU-1). Names the
   * Hoplon-owned structural + supervised-edit surfaces and the host-owned
   * raw-text/file companion that, together, form the "use Hoplon now" stack.
   */
  liveUsageBundle: LiveUsageBundleReport;
  /**
   * The `t-065` default-adoption truth handshake for the bundle path.
   * Names what defaults to Hoplon-owned primitives, what stays explicit
   * fallback, and the deferred V2 two-layer stance.
   */
  liveUseDefaults: LiveUseDefaultsReport;
  /**
   * Safe-edit truth handshake for autonomous hosts on the shipped
   * createHoplonEditSession/applyEdits path.
   */
  safeEdit: SafeEditCapabilityReport;
  /**
   * t-080 — multi-project registration and active-project pointer. Reports
   * the persisted project registry so operators and agents can distinguish
   * "active project" from "registered-but-not-current" and decide which
   * projectId to pass on subsequent requests.
   */
  projects: LauncherProjectsReport;
}

export interface LauncherStatusInput extends LauncherWorkspaceInput {
  readonly semanticRuntime?: SemanticRuntimeAdapters;
}

/**
 * Collect and return a structured launcher status report.
 *
 * Constructs a default engine against the resolved workspace, probes its
 * health, and returns a machine-readable truth report. Surface statuses here
 * reflect packaged support, not live socket reachability. The caller is
 * responsible for rendering this to stdout / JSON as appropriate.
 */
export async function runStatus(
  input: LauncherStatusInput = {},
): Promise<LauncherStatusReport> {
  const workspace = resolveLauncherWorkspace(input);
  ensureWorkspaceLayout(workspace);

  const engine = await createDefaultHoplonEngine({
    root: workspace.root,
    dbPath: workspace.dbPath,
    gitRepoDir: workspace.gitRepoDir,
    grammarsDir: workspace.grammarsDir,
    engineId: workspace.engineId,
    ...(input.semanticRuntime !== undefined
      ? { semanticRuntime: input.semanticRuntime }
      : {}),
  });

  const health = await engine.health();
  const extensionCapabilities = await engine.describeCapabilities({
    correlationId: 'launcher-status',
  });
  const grammarsPresent = grammarsDirHasAssets(workspace.grammarsDir);

  const capabilities: LauncherCapabilityReport[] = Object.entries(health.adapters)
    .map(([name, status]) => ({ name, status: mapAdapterStatus(status) }))
    .sort((a, b) => a.name.localeCompare(b.name));
  const codeIntelligenceStatus =
    capabilities.find((cap) => cap.name === 'codeIntelligence')?.status ??
    'unavailable';
  const projects = buildProjectsReport(workspace.root);

  return {
    version: 1,
    workspace,
    engineId: workspace.engineId,
    health,
    grammarsPresent,
    capabilities,
    extensionCapabilities: extensionCapabilities.capabilities,
    surfaces: { mcp: 'available', http: 'available' },
    liveUsageBundle: HOPLON_LIVE_USAGE_BUNDLE,
    liveUseDefaults: HOPLON_LIVE_USE_DEFAULTS,
    projects,
    safeEdit: buildSafeEditCapabilityReport({
      codeIntelligenceStatus,
      grammarsPresent,
    }),
  };
}

export {
  HOPLON_QUICK_EDIT_ADVERTISEMENT,
} from './quickEditAdvertisement.js';
export type {
  HoplonQuickEditAdvertisement,
} from './quickEditAdvertisement.js';

/**
 * The canonical Live Usage Bundle shape. Declared once as a typed constant so
 * tests, docs, and the status envelope all read the same truth handshake.
 */
export const HOPLON_LIVE_USAGE_BUNDLE: LiveUsageBundleReport = {
  name: 'hoplon-live-usage-bundle',
  hoplonSurfaces: {
    launcherCommands: [
      'hoplon status',
      'hoplon mcp serve',
      'hoplon http serve',
    ] as const,
    queryCommands: [
      'hoplon query capabilities',
      'hoplon query skeleton',
      'hoplon query structure',
      'hoplon query search',
      'hoplon query project',
      'hoplon query see',
    ] as const,
    editSessionEntry: 'createHoplonEditSession',
  },
  rawTextCompanion: {
    owner: 'host',
    coverage: [
      'docs',
      'configs',
      'env files',
      'logs',
      'binary content',
      'launcher unavailable',
    ] as const,
  },
};

function mapAdapterStatus(
  s: 'ok' | 'degraded' | 'failed',
): LauncherCapabilityReport['status'] {
  if (s === 'ok') return 'available';
  if (s === 'degraded') return 'degraded';
  return 'unavailable';
}

function grammarsDirHasAssets(dir: string): boolean {
  try {
    const entries = fs.readdirSync(dir);
    return entries.some((e) => e.endsWith('.wasm'));
  } catch {
    return false;
  }
}
