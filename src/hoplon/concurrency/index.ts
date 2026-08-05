/**
 * concurrency/index.ts — barrel export for Phase 2 Stage D concurrency primitives.
 *
 * W1: Worker thread pool for tree-sitter parses.
 * W4: Engine instance pool — lifecycle-managed HoplonEngine instances keyed by projectId.
 */

// W1 — Parser pool
export { createParserPool } from './parserPool.js';
export type {
  ParserPool,
  ParseRequest,
  SerializedSyntaxTree,
  SerializedNode,
  ParserPoolStats,
  ParserPoolOptions,
  SupportedLanguage,
} from './parserPool.js';

// W2 — Per-project mutex map
export { createPerProjectLockProvider } from '../adapters/lock-per-project.js';
export type { PerProjectLockProviderOptions } from '../adapters/lock-per-project.js';

// W4 — Engine instance pool
export {
  createHoplonEnginePool,
} from './enginePool.js';

export type {
  HoplonEnginePool,
  HoplonEnginePoolStats,
  HoplonEnginePoolOptions,
} from './enginePool.js';

// t-080 — Multi-project registration + per-project engine routing
export {
  createProjectRegistry,
  ProjectRegistryError,
} from './projectRegistry.js';
export type {
  ProjectRegistry,
  RegisteredProject,
  RegisterProjectInput,
  ProjectPolicy,
  ProjectRegistryErrorKind,
  CreateProjectRegistryOptions,
} from './projectRegistry.js';

export {
  createHoplonEngineRouter,
  EngineRouterError,
} from './engineRouter.js';
export type {
  HoplonEngineRouter,
  EngineBuilder,
  EngineRouterErrorKind,
  CreateEngineRouterOptions,
} from './engineRouter.js';

// t-082 — Folder-scoped project policy contract
export {
  FolderPolicyError,
  MIN_ENGAGEMENT_TOKEN_TTL_MS,
  MAX_ENGAGEMENT_TOKEN_TTL_MS,
  ACCESS_MODES,
  PRINCIPAL_KINDS,
  canonicalizeProjectRelativeFolder,
  resolveFolderAccess,
} from './projectPolicy.js';
export type {
  AccessMode,
  PrincipalKind,
  PolicyPrincipal,
  FolderRule,
  FolderPolicy,
  EngagementTokenBinding,
  EngagementTokenEnvelope,
  InvalidFolderReason,
  FolderPolicyResolution,
  FolderPolicyErrorKind,
} from './projectPolicy.js';
export { validateFolderPolicy } from './projectPolicyValidation.js';
