/**
 * authorization/policyBundle/loadPolicyData.ts — pure parser/validator
 * for the Hoplon OPA policy data document (T-149).
 *
 * STATUS: ADVISORY / FIXTURE-ONLY.
 *
 *   Parses the JSON document at `policy/data/hoplon_policy_data.json`
 *   into the typed `PolicyData` shape consumed by the in-process
 *   evaluator. No filesystem access here — callers pass the raw text.
 *
 * Architecture rules:
 *   - Pure function. No I/O, no clock, no randomness.
 *   - Returns a typed result envelope; never throws.
 *   - Named exports only. TypeScript strict. No `any`.
 */
import {
  parseBranches,
  parseGlobalDenies,
  parseProjects,
  parseSensitivePaths,
} from './loadPolicyDataSections.js';
import type { LoadPolicyDataResult } from './loadPolicyDataSections.js';

export type { LoadPolicyDataResult } from './loadPolicyDataSections.js';

/**
 * Parse a raw JSON string into a typed `PolicyData`. Returns a typed
 * result envelope; never throws on malformed input.
 */
export function parsePolicyDataJson(rawJson: string): LoadPolicyDataResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (err) {
    return {
      kind: 'malformed',
      field: 'root',
      reason: `JSON.parse failed: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return validatePolicyData(parsed);
}

/**
 * Validate an already-parsed unknown into a typed `PolicyData`.
 */
export function validatePolicyData(raw: unknown): LoadPolicyDataResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'malformed',
      field: 'root',
      reason: 'policy data must be a non-null object',
    };
  }
  const obj = raw as Record<string, unknown>;

  const policyVersion = obj['policyVersion'];
  if (typeof policyVersion !== 'string' || policyVersion.length === 0) {
    return {
      kind: 'malformed',
      field: 'policyVersion',
      reason: 'policyVersion must be a non-empty string',
    };
  }

  const defaultExpires = obj['defaultExpiresInSeconds'];
  if (
    typeof defaultExpires !== 'number' ||
    !Number.isFinite(defaultExpires) ||
    defaultExpires <= 0
  ) {
    return {
      kind: 'malformed',
      field: 'defaultExpiresInSeconds',
      reason: 'defaultExpiresInSeconds must be a finite positive number',
    };
  }

  const grantExpires = obj['grantExpiresInSeconds'];
  if (
    typeof grantExpires !== 'number' ||
    !Number.isFinite(grantExpires) ||
    grantExpires <= 0
  ) {
    return {
      kind: 'malformed',
      field: 'grantExpiresInSeconds',
      reason: 'grantExpiresInSeconds must be a finite positive number',
    };
  }

  const projectsResult = parseProjects(obj['projects']);
  if (projectsResult.kind === 'err') return projectsResult.err;

  const branchesResult = parseBranches(obj['branches']);
  if (branchesResult.kind === 'err') return branchesResult.err;

  const sensitiveResult = parseSensitivePaths(obj['sensitivePaths']);
  if (sensitiveResult.kind === 'err') return sensitiveResult.err;

  const denyResult = parseGlobalDenies(obj['globalDenies']);
  if (denyResult.kind === 'err') return denyResult.err;

  const revokedRaw = obj['revokedGrantIds'];
  if (!Array.isArray(revokedRaw)) {
    return {
      kind: 'malformed',
      field: 'revokedGrantIds',
      reason: 'revokedGrantIds must be an array of strings',
    };
  }
  const revokedGrantIds: string[] = [];
  for (let i = 0; i < revokedRaw.length; i++) {
    const v = revokedRaw[i];
    if (typeof v !== 'string' || v.length === 0) {
      return {
        kind: 'malformed',
        field: `revokedGrantIds[${String(i)}]`,
        reason: 'each revoked grantId must be a non-empty string',
      };
    }
    revokedGrantIds.push(v);
  }

  return {
    kind: 'ok',
    data: {
      policyVersion,
      defaultExpiresInSeconds: defaultExpires,
      grantExpiresInSeconds: grantExpires,
      projects: projectsResult.value,
      branches: branchesResult.value,
      sensitivePaths: sensitiveResult.value,
      globalDenies: denyResult.value,
      revokedGrantIds,
    },
  };
}
