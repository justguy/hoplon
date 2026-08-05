/**
 * launcher/index.ts — public barrel for the local launcher surface.
 *
 * Re-exports the programmatic entry points. The `hoplon` bin shells into
 * these same functions via `runCli`.
 */

export {
  runStatus,
  HOPLON_QUICK_EDIT_ADVERTISEMENT,
} from './status.js';
export type {
  LauncherStatusReport,
  LauncherCapabilityReport,
  SafeEditCapabilityReport,
  HoplonQuickEditAdvertisement,
} from './status.js';

export { runMcpServe } from './mcpServe.js';
export type { McpServeOptions, McpServeHandle, McpTransportMode } from './mcpServe.js';

export { runHttpServe } from './httpServe.js';
export type { HttpServeOptions, HttpServeHandle } from './httpServe.js';

export { runCli, parseCli, HELP_TEXT, QUERY_HELP_TEXT } from './cli.js';
export type { LauncherCommand, ParsedCli } from './cli.js';

export { runQuery, parseQueryCommand } from './query.js';
export type {
  QueryCommand,
  QueryCommandLabel,
  QueryEnvelope,
  QueryFormat,
  ParsedQueryCommand,
  RunQueryOptions,
} from './query.js';
export { renderQueryHuman } from './queryHuman.js';
export { renderReviewHuman } from './reviewHuman.js';
export type { RenderReviewHumanOptions } from './reviewHuman.js';

export { resolveLauncherWorkspace } from './config.js';
export type { LauncherWorkspaceConfig, LauncherWorkspaceInput } from './config.js';

// t-080 — multi-project registration surface
export { openLauncherProjects, LauncherProjectsError } from './projects.js';
export type {
  LauncherProjects,
  LauncherProjectsErrorKind,
} from './projects.js';
export { buildProjectsReport } from './projectsReport.js';
export type {
  LauncherProjectsReport,
  LauncherRegisteredProjectReport,
  LauncherProjectPolicySummary,
} from './projectsReport.js';
export {
  resolveProjectsStorePath,
  ProjectsStoreError,
  DEFAULT_PROJECTS_STORE_RELATIVE,
  PROJECTS_STORE_VERSION,
} from './projectsStore.js';
export type { ProjectsStoreErrorKind } from './projectsStore.js';
export { buildEngineForRegisteredProject } from './engineBootstrap.js';

// t-083 — project/folder handshake + engagement-token issuance
export {
  HandshakeError,
  issueProjectHandshake,
  DEFAULT_ENGAGEMENT_TOKEN_BYTES,
} from './handshake.js';
export type {
  HandshakeErrorKind,
  HandshakeMatchedRuleSummary,
  HandshakeRequest,
  HandshakeResult,
  IssueHandshakeDeps,
} from './handshake.js';

// T-146 — adapter-backed dynamic-authorization handshake
export {
  issueProjectHandshakeViaAdapter,
  DEFAULT_HANDSHAKE_BRANCH,
  DEFAULT_HANDSHAKE_ENVIRONMENT,
  legacyAccessFromCapabilities,
} from './handshakeAuthz.js';
export type {
  HandshakeAuthzResult,
  IssueHandshakeViaAdapterDeps,
} from './handshakeAuthz.js';
export {
  createInMemoryEngagementStore,
  openEngagementStore,
} from './engagementStore.js';
export type { EngagementStore } from './engagementStore.js';

// T-147 — sibling capability-claims store (option B retrieval)
export {
  createInMemoryCapabilityClaimsStore,
  openCapabilityClaimsStore,
} from '../authorization/capabilityClaimsStore.js';
export type { CapabilityClaimsStore } from '../authorization/capabilityClaimsStore.js';

// t-084 — engagement-token lifecycle (verify, renew, revoke, prune)
export {
  verifyEngagementToken,
  renewEngagementToken,
  revokeEngagementToken,
  pruneExpiredTokens,
} from './engagementLifecycle.js';
export type {
  CleanupReport,
  ReauthReason,
  TokenRenewal,
  TokenRevocation,
  TokenVerification,
  VerifyExpectation,
} from './engagementLifecycle.js';
