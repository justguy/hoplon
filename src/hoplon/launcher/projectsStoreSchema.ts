/**
 * launcher/projectsStoreSchema.ts — parse/serialize helpers for t-080
 * projects registry persistence.
 *
 * Kept separate from `projectsStore.ts` to honor the 300-line-per-file
 * architecture rule and to isolate the JSON-schema validation from the
 * atomic-write I/O surface.
 */

import type {
  RegisteredProject,
  ProjectPolicy,
} from '../concurrency/projectRegistry.js';
import {
  parsePersistedFolderPolicy,
  toPersistedFolderPolicy,
} from './projectsPolicySchema.js';
import type { PersistedFolderPolicy } from './projectsPolicySchema.js';
import { parseSecretPatterns } from './projectsSecretSchema.js';

export const PROJECTS_STORE_VERSION = 1;

export interface PersistedPolicy {
  revertAllowlist?: readonly string[];
  /**
   * Regex patterns serialized as `{source, flags}` pairs since JSON
   * cannot represent RegExp natively.
   */
  secretPatterns?: readonly { source: string; flags: string }[];
  maxFileBytes?: number;
  parseTimeoutMs?: number;
  /**
   * Folder-scoped agent handshake policy (t-082). Additive: existing
   * persisted files without this key continue to load unchanged.
   */
  folderPolicy?: PersistedFolderPolicy;
}

export interface PersistedProject {
  projectId: string;
  fsRoot: string;
  gitRepoDir: string;
  dbPath: string;
  grammarsDir: string;
  engineId: string;
  policy: PersistedPolicy;
  label: string;
  registeredAtIso: string;
}

export interface PersistedProjectsFile {
  version: typeof PROJECTS_STORE_VERSION;
  activeProjectId: string | null;
  projects: PersistedProject[];
}

export type SchemaErrorKind =
  | 'invalid_json'
  | 'invalid_schema'
  | 'invalid_version';

export class ProjectsSchemaError extends Error {
  public readonly kind: SchemaErrorKind;
  public readonly file: string;
  public override readonly cause?: unknown;

  constructor(
    kind: SchemaErrorKind,
    file: string,
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'ProjectsSchemaError';
    this.kind = kind;
    this.file = file;
    if (cause !== undefined) this.cause = cause;
  }
}

/**
 * Parse a decoded JSON root into the registry snapshot.
 *
 * A stale `activeProjectId` that does not reference a registered project
 * is silently dropped — the launcher boots honestly rather than refusing
 * to start just because the active pointer went stale.
 */
export function parseProjectsFile(
  parsed: unknown,
  filePath: string,
): { projects: RegisteredProject[]; activeProjectId: string | null } {
  if (parsed === null || typeof parsed !== 'object') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      'Projects registry root must be a JSON object',
    );
  }
  const obj = parsed as Record<string, unknown>;
  if (obj['version'] !== PROJECTS_STORE_VERSION) {
    throw new ProjectsSchemaError(
      'invalid_version',
      filePath,
      `Projects registry version ${String(
        obj['version'],
      )} is not supported (expected ${PROJECTS_STORE_VERSION})`,
    );
  }

  const activeRaw = obj['activeProjectId'];
  let activeProjectId: string | null;
  if (activeRaw === null || activeRaw === undefined) {
    activeProjectId = null;
  } else if (typeof activeRaw === 'string' && activeRaw.length > 0) {
    activeProjectId = activeRaw;
  } else {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      'activeProjectId must be a non-empty string or null',
    );
  }

  const projectsRaw = obj['projects'];
  if (!Array.isArray(projectsRaw)) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      'projects field must be an array',
    );
  }

  const projects: RegisteredProject[] = projectsRaw.map((entry, idx) =>
    parsePersistedProject(entry, idx, filePath),
  );

  if (
    activeProjectId !== null &&
    !projects.some((p) => p.projectId === activeProjectId)
  ) {
    activeProjectId = null;
  }

  return { projects, activeProjectId };
}

function parsePersistedProject(
  raw: unknown,
  idx: number,
  filePath: string,
): RegisteredProject {
  if (raw === null || typeof raw !== 'object') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${idx}] must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const requireString = (key: string): string => {
    const v = obj[key];
    if (typeof v !== 'string' || v.length === 0) {
      throw new ProjectsSchemaError(
        'invalid_schema',
        filePath,
        `projects[${idx}].${key} must be a non-empty string`,
      );
    }
    return v;
  };

  const policyRaw = obj['policy'];
  const policy: ProjectPolicy = parsePersistedPolicy(policyRaw, idx, filePath);

  return Object.freeze({
    projectId: requireString('projectId'),
    fsRoot: requireString('fsRoot'),
    gitRepoDir: requireString('gitRepoDir'),
    dbPath: requireString('dbPath'),
    grammarsDir: requireString('grammarsDir'),
    engineId: requireString('engineId'),
    label: requireString('label'),
    registeredAtIso: requireString('registeredAtIso'),
    policy: Object.freeze(policy),
  });
}

function parsePersistedPolicy(
  raw: unknown,
  idx: number,
  filePath: string,
): ProjectPolicy {
  if (raw === undefined || raw === null) return {};
  if (typeof raw !== 'object') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${idx}].policy must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const policy: ProjectPolicy = {};
  const schemaFail = (msg: string): never => {
    throw new ProjectsSchemaError('invalid_schema', filePath, msg);
  };

  if (obj['revertAllowlist'] !== undefined) {
    const v = obj['revertAllowlist'];
    if (!Array.isArray(v) || !v.every((p) => typeof p === 'string')) {
      schemaFail(`projects[${idx}].policy.revertAllowlist must be a string[]`);
    }
    policy.revertAllowlist = v as readonly string[];
  }

  if (obj['secretPatterns'] !== undefined) {
    policy.secretPatterns = parseSecretPatterns(obj['secretPatterns'], idx, filePath);
  }

  for (const key of ['maxFileBytes', 'parseTimeoutMs'] as const) {
    const v = obj[key];
    if (v === undefined) continue;
    if (typeof v !== 'number' || !Number.isInteger(v) || v <= 0) {
      schemaFail(`projects[${idx}].policy.${key} must be a positive integer`);
    }
    policy[key] = v as number;
  }

  if (obj['folderPolicy'] !== undefined) {
    policy.folderPolicy = parsePersistedFolderPolicy(
      obj['folderPolicy'],
      idx,
      filePath,
    );
  }

  return policy;
}

export function toPersistedProject(p: RegisteredProject): PersistedProject {
  return {
    projectId: p.projectId,
    fsRoot: p.fsRoot,
    gitRepoDir: p.gitRepoDir,
    dbPath: p.dbPath,
    grammarsDir: p.grammarsDir,
    engineId: p.engineId,
    label: p.label,
    registeredAtIso: p.registeredAtIso,
    policy: toPersistedPolicy(p.policy),
  };
}

export function toPersistedPolicy(policy: ProjectPolicy): PersistedPolicy {
  const out: PersistedPolicy = {};
  if (policy.revertAllowlist !== undefined) {
    out.revertAllowlist = [...policy.revertAllowlist];
  }
  if (policy.secretPatterns !== undefined) {
    out.secretPatterns = policy.secretPatterns.map((p) => ({
      source: p.source,
      flags: p.flags,
    }));
  }
  if (policy.maxFileBytes !== undefined) out.maxFileBytes = policy.maxFileBytes;
  if (policy.parseTimeoutMs !== undefined)
    out.parseTimeoutMs = policy.parseTimeoutMs;
  if (policy.folderPolicy !== undefined) {
    out.folderPolicy = toPersistedFolderPolicy(policy.folderPolicy);
  }
  return out;
}
