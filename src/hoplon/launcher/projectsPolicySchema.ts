/**
 * launcher/projectsPolicySchema.ts — parse/serialize helpers for the
 * t-082 folder-scoped policy surface inside the persisted projects
 * registry.
 *
 * Kept separate from `projectsStoreSchema.ts` so that file stays under
 * the 300-line architecture cap and so the folder-policy contract has
 * one place to grow when `t-083` adds handshake bookkeeping.
 *
 * On-disk shape is additive over the original t-080 `PersistedProject`:
 * existing files without a `folderPolicy` key keep loading unchanged.
 * The schema version stays at `1` because the addition is backward-
 * compatible on read.
 */

import { validateFolderPolicy } from '../concurrency/projectPolicyValidation.js';
import type {
  FolderPolicy,
  FolderRule,
  PolicyPrincipal,
} from '../concurrency/projectPolicy.js';
import { ProjectsSchemaError } from './projectsStoreSchema.js';

export interface PersistedFolderRule {
  folder: string;
  access: string;
  appliesToPrincipalIds?: readonly string[];
}

export interface PersistedPolicyPrincipal {
  principalId: string;
  kind: string;
  label?: string;
}

export interface PersistedFolderPolicy {
  defaultAccess: string;
  folderRules: readonly PersistedFolderRule[];
  engagementTokenTtlMs: number;
  principals?: readonly PersistedPolicyPrincipal[];
}

export function parsePersistedFolderPolicy(
  raw: unknown,
  projectIdx: number,
  filePath: string,
): FolderPolicy {
  if (raw === null || typeof raw !== 'object') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;

  const defaultAccess = obj['defaultAccess'];
  if (typeof defaultAccess !== 'string' || defaultAccess.length === 0) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.defaultAccess must be a non-empty string`,
    );
  }

  const ttl = obj['engagementTokenTtlMs'];
  if (typeof ttl !== 'number') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.engagementTokenTtlMs must be a number`,
    );
  }

  const rulesRaw = obj['folderRules'];
  if (!Array.isArray(rulesRaw)) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.folderRules must be an array`,
    );
  }
  const folderRules: FolderRule[] = rulesRaw.map((entry, i) =>
    parsePersistedRule(entry, projectIdx, i, filePath),
  );

  let principals: PolicyPrincipal[] | undefined;
  if (obj['principals'] !== undefined) {
    if (!Array.isArray(obj['principals'])) {
      throw new ProjectsSchemaError(
        'invalid_schema',
        filePath,
        `projects[${projectIdx}].policy.folderPolicy.principals must be an array when present`,
      );
    }
    principals = obj['principals'].map((entry, i) =>
      parsePersistedPrincipal(entry, projectIdx, i, filePath),
    );
  }

  const policy: FolderPolicy = {
    defaultAccess: defaultAccess as FolderPolicy['defaultAccess'],
    folderRules,
    engagementTokenTtlMs: ttl,
    ...(principals !== undefined ? { principals } : {}),
  };
  try {
    return validateFolderPolicy(policy);
  } catch (err) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy failed contract validation: ${
        err instanceof Error ? err.message : String(err)
      }`,
      err,
    );
  }
}

function parsePersistedRule(
  raw: unknown,
  projectIdx: number,
  ruleIdx: number,
  filePath: string,
): FolderRule {
  if (raw === null || typeof raw !== 'object') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.folderRules[${ruleIdx}] must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const folder = obj['folder'];
  const access = obj['access'];
  if (typeof folder !== 'string') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.folderRules[${ruleIdx}].folder must be a string (use '' for project root)`,
    );
  }
  if (typeof access !== 'string' || access.length === 0) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.folderRules[${ruleIdx}].access must be a non-empty string`,
    );
  }
  const rule: FolderRule = { folder, access: access as FolderRule['access'] };
  if (obj['appliesToPrincipalIds'] !== undefined) {
    const arr = obj['appliesToPrincipalIds'];
    if (
      !Array.isArray(arr) ||
      arr.some((p) => typeof p !== 'string' || p.length === 0)
    ) {
      throw new ProjectsSchemaError(
        'invalid_schema',
        filePath,
        `projects[${projectIdx}].policy.folderPolicy.folderRules[${ruleIdx}].appliesToPrincipalIds must be a string[]`,
      );
    }
    (rule as { appliesToPrincipalIds?: readonly string[] }).appliesToPrincipalIds =
      arr as readonly string[];
  }
  return rule;
}

function parsePersistedPrincipal(
  raw: unknown,
  projectIdx: number,
  principalIdx: number,
  filePath: string,
): PolicyPrincipal {
  if (raw === null || typeof raw !== 'object') {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.principals[${principalIdx}] must be an object`,
    );
  }
  const obj = raw as Record<string, unknown>;
  const principalId = obj['principalId'];
  const kind = obj['kind'];
  if (typeof principalId !== 'string' || principalId.length === 0) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.principals[${principalIdx}].principalId must be a non-empty string`,
    );
  }
  if (typeof kind !== 'string' || kind.length === 0) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${projectIdx}].policy.folderPolicy.principals[${principalIdx}].kind must be a non-empty string`,
    );
  }
  const record: PolicyPrincipal = {
    principalId,
    kind: kind as PolicyPrincipal['kind'],
  };
  if (obj['label'] !== undefined) {
    if (typeof obj['label'] !== 'string') {
      throw new ProjectsSchemaError(
        'invalid_schema',
        filePath,
        `projects[${projectIdx}].policy.folderPolicy.principals[${principalIdx}].label must be a string when present`,
      );
    }
    (record as { label?: string }).label = obj['label'];
  }
  return record;
}

export function toPersistedFolderPolicy(
  policy: FolderPolicy,
): PersistedFolderPolicy {
  const rules: PersistedFolderRule[] = policy.folderRules.map((r) => {
    const out: PersistedFolderRule = { folder: r.folder, access: r.access };
    if (r.appliesToPrincipalIds !== undefined) {
      out.appliesToPrincipalIds = [...r.appliesToPrincipalIds];
    }
    return out;
  });
  const out: PersistedFolderPolicy = {
    defaultAccess: policy.defaultAccess,
    folderRules: rules,
    engagementTokenTtlMs: policy.engagementTokenTtlMs,
  };
  if (policy.principals !== undefined) {
    out.principals = policy.principals.map((p) => {
      const rec: PersistedPolicyPrincipal = {
        principalId: p.principalId,
        kind: p.kind,
      };
      if (p.label !== undefined) rec.label = p.label;
      return rec;
    });
  }
  return out;
}
