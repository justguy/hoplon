/**
 * authorization/normalizeScopeClaim.ts — pure helpers for normalizing
 * a raw `ScopeClaim` and a `TokenCapabilities` map from arbitrary
 * `unknown` input (T-145).
 *
 * Split out from `normalizeOpaDecision.ts` to honor the 300-line file
 * cap. Has no behavior tests of its own — coverage flows through
 * `normalizeOpaDecision.test.ts`.
 *
 * Architecture rules:
 *   - Pure functions. No I/O, no time, no randomness.
 *   - Named exports only. TypeScript strict. No `any`.
 */
import type { ScopeClaim, TokenCapabilities } from './authorizationAdapter.js';

const CAPABILITY_KEYS = ['read', 'search', 'write', 'lock', 'snapshot'] as const;

export type CapabilityKey = (typeof CAPABILITY_KEYS)[number];

/** Result envelope for capabilities-map normalization. */
export type NormalizeCapabilitiesResult =
  | { kind: 'ok'; capabilities: TokenCapabilities }
  | { kind: 'malformed'; field: string; reason: string };

/** Result envelope for single-claim normalization. */
export type NormalizeScopeClaimResult =
  | { kind: 'ok'; claim: ScopeClaim }
  | { kind: 'malformed'; field: string; reason: string };

export const ALL_CAPABILITY_KEYS: ReadonlyArray<CapabilityKey> = CAPABILITY_KEYS;

/** Count how many capability keys are present on a normalized map. */
export function countCapabilities(caps: TokenCapabilities): number {
  let n = 0;
  for (const k of CAPABILITY_KEYS) {
    if (caps[k] !== undefined) n += 1;
  }
  return n;
}

/** Normalize a free-form `unknown` into a `TokenCapabilities` map. */
export function normalizeCapabilities(
  raw: unknown,
): NormalizeCapabilitiesResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'malformed',
      field: 'capabilities',
      reason: 'capabilities must be a non-null object',
    };
  }
  const src = raw as Record<string, unknown>;
  const out: TokenCapabilities = {};
  for (const key of CAPABILITY_KEYS) {
    if (src[key] === undefined) continue;
    const claimResult = normalizeScopeClaim(src[key], `capabilities.${key}`);
    if (claimResult.kind === 'malformed') return claimResult;
    out[key] = claimResult.claim;
  }
  return { kind: 'ok', capabilities: out };
}

/** Normalize a free-form `unknown` into a single `ScopeClaim`. */
export function normalizeScopeClaim(
  raw: unknown,
  fieldPrefix: string,
): NormalizeScopeClaimResult {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return {
      kind: 'malformed',
      field: fieldPrefix,
      reason: 'scope claim must be a non-null object',
    };
  }
  const c = raw as Record<string, unknown>;

  const pathsErr = validateNonEmptyStringArray(c['paths'], `${fieldPrefix}.paths`);
  if (pathsErr !== null) return pathsErr;
  const branchesErr = validateNonEmptyStringArray(
    c['branches'],
    `${fieldPrefix}.branches`,
  );
  if (branchesErr !== null) return branchesErr;

  const claim: ScopeClaim = {
    paths: c['paths'] as string[],
    branches: c['branches'] as string[],
  };

  const optStringArray: Array<['deniedPaths' | 'astNodeIds' | 'astSelectors']> = [
    ['deniedPaths'],
    ['astNodeIds'],
    ['astSelectors'],
  ];
  for (const [optKey] of optStringArray) {
    if (c[optKey] === undefined) continue;
    const v = c[optKey];
    if (
      !Array.isArray(v) ||
      !v.every((s) => typeof s === 'string' && s.length > 0)
    ) {
      return {
        kind: 'malformed',
        field: `${fieldPrefix}.${optKey}`,
        reason: `${optKey}, when present, must be an array of non-empty strings`,
      };
    }
    claim[optKey] = v as string[];
  }

  for (const numKey of ['maxOperations', 'maxFilesTouched'] as const) {
    if (c[numKey] === undefined) continue;
    const v = c[numKey];
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return {
        kind: 'malformed',
        field: `${fieldPrefix}.${numKey}`,
        reason: `${numKey}, when present, must be a finite non-negative number`,
      };
    }
    claim[numKey] = v;
  }

  return { kind: 'ok', claim };
}

function validateNonEmptyStringArray(
  v: unknown,
  field: string,
): NormalizeScopeClaimResult | null {
  if (!Array.isArray(v) || v.length === 0) {
    return {
      kind: 'malformed',
      field,
      reason: `${field.split('.').pop() ?? field} must be a non-empty string array`,
    };
  }
  for (let i = 0; i < v.length; i++) {
    const x = v[i];
    if (typeof x !== 'string' || x.length === 0) {
      return {
        kind: 'malformed',
        field: `${field}[${String(i)}]`,
        reason: `each entry of ${field} must be a non-empty string`,
      };
    }
  }
  return null;
}
