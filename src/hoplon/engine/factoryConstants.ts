/** Stable engine factory defaults, centralized for split factory phases. */

export const DEFAULT_ENGINE_ID = 'local-0';
export const DEFAULT_GIT_REPO_DIR = '.hoplon/repo';
export const DEFAULT_REVERT_ALLOWLIST = [
  '.git/**',
  'node_modules/**',
  '.hoplon/**',
];
export const DEFAULT_MANIFEST_STORAGE_MODE = 'inline' as const;
export const DEFAULT_PENDING_ORPHAN_THRESHOLD_MS = 60_000;
export const DEFAULT_TTL_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
