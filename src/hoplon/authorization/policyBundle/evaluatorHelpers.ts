import { matchGlobAny, matchGlobPattern } from '../capabilityGlob.js';
import type { ActiveGrant } from '../activeGrantClient.js';
import type {
  ScopeClaim,
  TokenCapabilities,
} from '../authorizationAdapter.js';
import type {
  BranchCapabilityDisposition,
  PolicyBranchRule,
  PolicyData,
  PolicySensitivePath,
} from './types.js';
import { BUNDLE_CAPABILITY_KEYS } from './evaluatorTypes.js';
import type {
  BundleCapabilityKey,
  BundleOpaInput,
} from './evaluatorTypes.js';

export function matchGlobalDeny(
  policy: PolicyData,
  input: BundleOpaInput,
): string | null {
  for (const entry of policy.globalDenies) {
    if (entry.projectId !== undefined && entry.projectId !== input.request.projectId) continue;
    if (entry.principalId !== undefined && entry.principalId !== input.principal.id) continue;
    if (entry.capability !== undefined && !input.request.capabilities.includes(entry.capability)) continue;
    if (entry.pathPattern !== undefined) {
      const paths = input.request.paths ?? [];
      const anyHit = paths.some((p) => matchGlobPattern(p, entry.pathPattern as string));
      if (!anyHit) continue;
    }
    return entry.reason ?? `${entry.projectId ?? '*'}:${entry.principalId ?? '*'}:${entry.capability ?? '*'}:${entry.pathPattern ?? '*'}`;
  }
  return null;
}

type SensitiveHit = {
  pattern: string;
  disposition: 'requires_security_approval' | 'deny';
};

export function matchSensitivePath(
  policy: PolicyData,
  input: BundleOpaInput,
): SensitiveHit | null {
  const paths = input.request.paths;
  if (!paths || paths.length === 0) return null;
  for (const path of paths) {
    for (const entry of policy.sensitivePaths) {
      if (!matchGlobPattern(path, entry.pattern)) continue;
      const dispOrNull = strictestSensitiveCap(entry, input.request.capabilities);
      if (dispOrNull === null) continue;
      return { pattern: entry.pattern, disposition: dispOrNull };
    }
  }
  return null;
}

function strictestSensitiveCap(
  entry: PolicySensitivePath,
  requested: ReadonlyArray<BundleCapabilityKey>,
): SensitiveHit['disposition'] | null {
  let strict: SensitiveHit['disposition'] | null = null;
  for (const cap of requested) {
    const value = entry[cap];
    if (value === 'deny') return 'deny';
    if (value === 'requires_security_approval') {
      strict = 'requires_security_approval';
    }
  }
  return strict;
}

export function projectDisposition(
  project: PolicyData['projects'][string],
  cap: BundleCapabilityKey,
): 'allow' | 'requires_escalation' {
  return project.default[cap] ?? 'requires_escalation';
}

export function branchDisposition(
  policy: PolicyData,
  projectId: string,
  branch: string,
  cap: BundleCapabilityKey,
): BranchCapabilityDisposition {
  const rules = policy.branches[projectId];
  if (rules === undefined) return 'allow';
  const literal = rules[branch];
  if (literal !== undefined) {
    const disposition = literal[cap];
    if (disposition !== undefined) return disposition;
  }
  for (const [pattern, rule] of Object.entries(rules)) {
    if (pattern === branch) continue;
    if (!pattern.includes('*')) continue;
    if (!matchGlobPattern(branch, pattern)) continue;
    const disposition = (rule as PolicyBranchRule)[cap];
    if (disposition !== undefined) return disposition;
  }
  return 'allow';
}

export function matchActiveGrants(
  policy: PolicyData,
  input: BundleOpaInput,
  requestedCaps: ReadonlyArray<BundleCapabilityKey>,
): ActiveGrant[] {
  const nowMs = Date.parse(input.context.now);
  const out: ActiveGrant[] = [];
  for (const grant of input.activeGrants) {
    if (grant.principalId !== input.principal.id) continue;
    if (grant.taskId !== input.task.id) continue;
    if (grant.projectId !== input.request.projectId) continue;
    if (policy.revokedGrantIds.includes(grant.grantId)) continue;
    const expiresMs = Date.parse(grant.expiresAt);
    if (!Number.isFinite(expiresMs) || expiresMs <= nowMs) continue;
    if (!grantCoversAllRequests(grant, input, requestedCaps)) continue;
    out.push(grant);
  }
  return out;
}

function grantCoversAllRequests(
  grant: ActiveGrant,
  input: BundleOpaInput,
  requestedCaps: ReadonlyArray<BundleCapabilityKey>,
): boolean {
  for (const cap of requestedCaps) {
    const claim = grant.scope[cap];
    if (claim === undefined) return false;
    if (!matchGlobAny(input.request.branch, claim.branches)) return false;
    const paths = input.request.paths ?? [];
    if (paths.length === 0) {
      if (!claim.paths.includes('**')) return false;
      continue;
    }
    for (const path of paths) {
      if (!matchGlobAny(path, claim.paths)) return false;
    }
  }
  return true;
}

export function bundledRequestCapabilities(
  raw: ReadonlyArray<BundleCapabilityKey>,
): BundleCapabilityKey[] {
  const out: BundleCapabilityKey[] = [];
  for (const cap of raw) {
    if ((BUNDLE_CAPABILITY_KEYS as readonly string[]).includes(cap)) {
      out.push(cap as BundleCapabilityKey);
    }
  }
  return out;
}

export function standingPolicyCapabilities(
  requestedCaps: ReadonlyArray<BundleCapabilityKey>,
  _input: BundleOpaInput,
): TokenCapabilities {
  const out: TokenCapabilities = {};
  for (const cap of requestedCaps) {
    out[cap] = { paths: ['**'], branches: ['**'] };
  }
  return out;
}

export function grantCapabilities(
  grants: ReadonlyArray<ActiveGrant>,
  requestedCaps: ReadonlyArray<BundleCapabilityKey>,
  _input: BundleOpaInput,
): TokenCapabilities {
  const out: TokenCapabilities = {};
  for (const cap of requestedCaps) {
    const claims: ScopeClaim[] = [];
    for (const grant of grants) {
      const claim = grant.scope[cap];
      if (claim !== undefined) claims.push(claim);
    }
    if (claims.length === 0) continue;
    out[cap] = mergeScopeClaims(claims);
  }
  return out;
}

function mergeScopeClaims(claims: ReadonlyArray<ScopeClaim>): ScopeClaim {
  const paths = new Set<string>();
  const branches = new Set<string>();
  for (const claim of claims) {
    for (const path of claim.paths) paths.add(path);
    for (const branch of claim.branches) branches.add(branch);
  }
  return { paths: [...paths], branches: [...branches] };
}

export function requestedScopeObject(input: BundleOpaInput): TokenCapabilities {
  const requested = bundledRequestCapabilities(input.request.capabilities);
  const out: TokenCapabilities = {};
  const paths =
    input.request.paths !== undefined && input.request.paths.length > 0
      ? [...input.request.paths]
      : ['**'];
  for (const cap of requested) {
    out[cap] = { paths, branches: [input.request.branch] };
  }
  return out;
}
