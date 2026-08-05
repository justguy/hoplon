/**
 * concurrency/projectPolicyValidation.ts — validator for the folder-scoped
 * project policy contract (t-082).
 *
 * Pure data validation. `validateFolderPolicy(policy)` returns a new
 * frozen `FolderPolicy` with every rule canonicalized, every principal
 * de-duplicated, and every invariant checked. A bad shape throws
 * `FolderPolicyError` with a structured `kind` — callers never have to
 * parse an error message to tell what went wrong.
 *
 * Kept separate from `projectPolicy.ts` so both files stay under the
 * 300-line architecture cap and so the pure resolver can be imported
 * without pulling in the validator machinery.
 */

import {
  ACCESS_MODES,
  FolderPolicyError,
  MAX_ENGAGEMENT_TOKEN_TTL_MS,
  MIN_ENGAGEMENT_TOKEN_TTL_MS,
  PRINCIPAL_KINDS,
  canonicalizeProjectRelativeFolder,
} from './projectPolicy.js';
import type {
  FolderPolicy,
  FolderRule,
  PolicyPrincipal,
} from './projectPolicy.js';

/**
 * Validate + normalize a folder policy. Idempotent: passing the result
 * back through yields an identical policy.
 */
export function validateFolderPolicy(policy: FolderPolicy): FolderPolicy {
  if (!ACCESS_MODES.includes(policy.defaultAccess)) {
    throw new FolderPolicyError(
      'invalid_mode',
      `folderPolicy.defaultAccess must be one of ${ACCESS_MODES.join(
        ', ',
      )}; got '${String(policy.defaultAccess)}'`,
    );
  }
  if (
    !Number.isInteger(policy.engagementTokenTtlMs) ||
    policy.engagementTokenTtlMs < MIN_ENGAGEMENT_TOKEN_TTL_MS ||
    policy.engagementTokenTtlMs > MAX_ENGAGEMENT_TOKEN_TTL_MS
  ) {
    throw new FolderPolicyError(
      'invalid_ttl',
      `folderPolicy.engagementTokenTtlMs must be an integer in [${MIN_ENGAGEMENT_TOKEN_TTL_MS}, ${MAX_ENGAGEMENT_TOKEN_TTL_MS}]; got '${String(
        policy.engagementTokenTtlMs,
      )}'`,
    );
  }

  const principals = normalizePrincipals(policy.principals);
  const knownPrincipalIds = new Set(principals.map((p) => p.principalId));
  const rules = normalizeFolderRules(policy.folderRules ?? [], knownPrincipalIds);

  const normalized: FolderPolicy = {
    defaultAccess: policy.defaultAccess,
    folderRules: Object.freeze(rules),
    engagementTokenTtlMs: policy.engagementTokenTtlMs,
    ...(principals.length > 0 ? { principals: Object.freeze(principals) } : {}),
  };
  return Object.freeze(normalized);
}

function normalizePrincipals(
  raw: readonly PolicyPrincipal[] | undefined,
): PolicyPrincipal[] {
  if (raw === undefined) return [];
  const seen = new Set<string>();
  const out: PolicyPrincipal[] = [];
  for (const p of raw) {
    if (typeof p !== 'object' || p === null) {
      throw new FolderPolicyError(
        'invalid_principal',
        'folderPolicy.principals[] entries must be objects',
      );
    }
    if (typeof p.principalId !== 'string' || p.principalId.length === 0) {
      throw new FolderPolicyError(
        'invalid_principal',
        'folderPolicy.principals[].principalId must be a non-empty string',
      );
    }
    if (!PRINCIPAL_KINDS.includes(p.kind)) {
      throw new FolderPolicyError(
        'invalid_principal',
        `folderPolicy.principals[].kind must be one of ${PRINCIPAL_KINDS.join(
          ', ',
        )}; got '${String(p.kind)}' (principalId='${p.principalId}')`,
      );
    }
    if (seen.has(p.principalId)) {
      throw new FolderPolicyError(
        'invalid_principal',
        `duplicate principalId '${p.principalId}' in folderPolicy.principals[]`,
      );
    }
    if (p.label !== undefined && typeof p.label !== 'string') {
      throw new FolderPolicyError(
        'invalid_principal',
        `folderPolicy.principals[].label must be a string when present (principalId='${p.principalId}')`,
      );
    }
    seen.add(p.principalId);
    out.push(
      Object.freeze({
        principalId: p.principalId,
        kind: p.kind,
        ...(p.label !== undefined ? { label: p.label } : {}),
      }),
    );
  }
  return out;
}

function normalizeFolderRules(
  raw: readonly FolderRule[],
  knownPrincipalIds: ReadonlySet<string>,
): FolderRule[] {
  const out: FolderRule[] = [];
  const dedup = new Set<string>();
  const specificPrincipalSetsByFolder = new Map<string, (readonly string[])[]>();

  for (let i = 0; i < raw.length; i++) {
    const r = raw[i]!;
    if (!ACCESS_MODES.includes(r.access)) {
      throw new FolderPolicyError(
        'invalid_mode',
        `folderPolicy.folderRules[${i}].access must be one of ${ACCESS_MODES.join(
          ', ',
        )}; got '${String(r.access)}'`,
      );
    }
    const canon = canonicalizeProjectRelativeFolder(r.folder);
    if (!canon.ok) {
      throw new FolderPolicyError(
        'invalid_folder',
        `folderPolicy.folderRules[${i}].folder is invalid (${canon.reason}): '${String(
          r.folder,
        )}'`,
      );
    }

    let principalIds: readonly string[] | undefined;
    if (r.appliesToPrincipalIds !== undefined) {
      if (
        !Array.isArray(r.appliesToPrincipalIds) ||
        r.appliesToPrincipalIds.some(
          (p) => typeof p !== 'string' || p.length === 0,
        )
      ) {
        throw new FolderPolicyError(
          'invalid_rule',
          `folderPolicy.folderRules[${i}].appliesToPrincipalIds must be a non-empty string[]`,
        );
      }
      if (r.appliesToPrincipalIds.length === 0) {
        throw new FolderPolicyError(
          'invalid_rule',
          `folderPolicy.folderRules[${i}].appliesToPrincipalIds must contain at least one principal id; omit the field to apply to all principals`,
        );
      }
      for (const pid of r.appliesToPrincipalIds) {
        if (!knownPrincipalIds.has(pid)) {
          throw new FolderPolicyError(
            'unknown_principal_ref',
            `folderPolicy.folderRules[${i}] references unknown principalId '${pid}' — declare it in folderPolicy.principals[] or omit the filter`,
          );
        }
      }
      principalIds = Object.freeze(
        [...new Set(r.appliesToPrincipalIds)].sort(),
      );
    }

    const key = `${canon.canonical}\0${principalIds ? principalIds.join(',') : '*'}`;
    if (dedup.has(key)) {
      throw new FolderPolicyError(
        'duplicate_rule',
        `folderPolicy.folderRules[${i}] duplicates an earlier rule for folder '${canon.canonical}' and principal set ${
          principalIds ? `[${principalIds.join(',')}]` : '*'
        }`,
      );
    }
    dedup.add(key);

    if (principalIds !== undefined) {
      const priorSets = specificPrincipalSetsByFolder.get(canon.canonical) ?? [];
      for (const priorSet of priorSets) {
        if (principalSetsOverlap(priorSet, principalIds)) {
          throw new FolderPolicyError(
            'duplicate_rule',
            `folderPolicy.folderRules[${i}] overlaps an earlier principal-specific rule for folder '${canon.canonical}' on at least one principal id`,
          );
        }
      }
      priorSets.push(principalIds);
      specificPrincipalSetsByFolder.set(canon.canonical, priorSets);
    }

    out.push(
      Object.freeze({
        folder: canon.canonical,
        access: r.access,
        ...(principalIds !== undefined
          ? { appliesToPrincipalIds: principalIds }
          : {}),
      }),
    );
  }
  return out;
}

function principalSetsOverlap(
  left: readonly string[],
  right: readonly string[],
): boolean {
  const rightIds = new Set(right);
  return left.some((principalId) => rightIds.has(principalId));
}
