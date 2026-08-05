import type {
  BranchCapabilityDisposition,
  PolicyBranchRule,
  PolicyData,
  PolicyGlobalDeny,
  PolicyProject,
  PolicySensitivePath,
  ProjectCapabilityDisposition,
  SensitivePathCapabilityDisposition,
} from './types.js';

export type LoadPolicyDataResult =
  | { kind: 'ok'; data: PolicyData }
  | { kind: 'malformed'; field: string; reason: string };

type ParseRes<T> =
  | { kind: 'ok'; value: T }
  | { kind: 'err'; err: LoadPolicyDataResult };

const PROJECT_DISPOSITIONS = new Set<ProjectCapabilityDisposition>([
  'allow',
  'requires_escalation',
]);
const BRANCH_DISPOSITIONS = new Set<BranchCapabilityDisposition>([
  'allow',
  'requires_escalation',
  'requires_human_approval',
]);
const SENSITIVE_DISPOSITIONS = new Set<SensitivePathCapabilityDisposition>([
  'requires_security_approval',
  'deny',
]);
const CAPABILITY_KEYS = ['read', 'search', 'write', 'lock', 'snapshot'] as const;

export function parseProjects(
  raw: unknown,
): ParseRes<Record<string, PolicyProject>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return errAt('projects', 'projects must be an object keyed by projectId');
  }
  const out: Record<string, PolicyProject> = {};
  for (const [projectId, value] of Object.entries(raw as Record<string, unknown>)) {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      return errAt(`projects.${projectId}`, 'project entry must be an object');
    }
    const projObj = value as Record<string, unknown>;
    const def = projObj['default'];
    if (def === null || typeof def !== 'object' || Array.isArray(def)) {
      return errAt(`projects.${projectId}.default`, 'default must be an object');
    }
    const defObj = def as Record<string, unknown>;
    const project: PolicyProject = {
      default: {
        read: 'allow',
        search: 'allow',
        write: 'allow',
        lock: 'allow',
        snapshot: 'allow',
      },
      token: { maxTtlSeconds: 0 },
    };
    for (const cap of CAPABILITY_KEYS) {
      const valueForCapability = defObj[cap];
      if (
        typeof valueForCapability !== 'string' ||
        !PROJECT_DISPOSITIONS.has(
          valueForCapability as ProjectCapabilityDisposition,
        )
      ) {
        return errAt(
          `projects.${projectId}.default.${cap}`,
          `must be one of ${[...PROJECT_DISPOSITIONS].join('|')}`,
        );
      }
      project.default[cap] =
        valueForCapability as ProjectCapabilityDisposition;
    }
    const token = projObj['token'];
    if (token === null || typeof token !== 'object' || Array.isArray(token)) {
      return errAt(`projects.${projectId}.token`, 'token must be an object');
    }
    const ttl = (token as Record<string, unknown>)['maxTtlSeconds'];
    if (typeof ttl !== 'number' || !Number.isFinite(ttl) || ttl <= 0) {
      return errAt(
        `projects.${projectId}.token.maxTtlSeconds`,
        'must be a finite positive number',
      );
    }
    project.token.maxTtlSeconds = ttl;
    out[projectId] = project;
  }
  return { kind: 'ok', value: out };
}

export function parseBranches(
  raw: unknown,
): ParseRes<Record<string, Record<string, PolicyBranchRule>>> {
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return errAt('branches', 'branches must be an object keyed by projectId');
  }
  const out: Record<string, Record<string, PolicyBranchRule>> = {};
  for (const [projectId, perProject] of Object.entries(raw as Record<string, unknown>)) {
    if (perProject === null || typeof perProject !== 'object' || Array.isArray(perProject)) {
      return errAt(`branches.${projectId}`, 'must be an object keyed by branch pattern');
    }
    const branchMap: Record<string, PolicyBranchRule> = {};
    for (const [pattern, rule] of Object.entries(perProject as Record<string, unknown>)) {
      if (rule === null || typeof rule !== 'object' || Array.isArray(rule)) {
        return errAt(`branches.${projectId}.${pattern}`, 'rule must be an object');
      }
      const ruleObj = rule as Record<string, unknown>;
      const parsed: PolicyBranchRule = {};
      for (const cap of CAPABILITY_KEYS) {
        if (ruleObj[cap] === undefined) continue;
        const value = ruleObj[cap];
        if (
          typeof value !== 'string' ||
          !BRANCH_DISPOSITIONS.has(value as BranchCapabilityDisposition)
        ) {
          return errAt(
            `branches.${projectId}.${pattern}.${cap}`,
            `must be one of ${[...BRANCH_DISPOSITIONS].join('|')}`,
          );
        }
        parsed[cap] = value as BranchCapabilityDisposition;
      }
      branchMap[pattern] = parsed;
    }
    out[projectId] = branchMap;
  }
  return { kind: 'ok', value: out };
}

export function parseSensitivePaths(raw: unknown): ParseRes<PolicySensitivePath[]> {
  if (!Array.isArray(raw)) {
    return errAt('sensitivePaths', 'sensitivePaths must be an array');
  }
  const out: PolicySensitivePath[] = [];
  for (let index = 0; index < raw.length; index++) {
    const entry = raw[index];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return errAt(`sensitivePaths[${String(index)}]`, 'entry must be an object');
    }
    const value = entry as Record<string, unknown>;
    if (typeof value['pattern'] !== 'string' || value['pattern'].length === 0) {
      return errAt(
        `sensitivePaths[${String(index)}].pattern`,
        'pattern must be a non-empty string',
      );
    }
    const parsed: PolicySensitivePath = { pattern: value['pattern'] };
    let hasAtLeastOne = false;
    for (const cap of CAPABILITY_KEYS) {
      if (value[cap] === undefined) continue;
      const disposition = value[cap];
      if (
        typeof disposition !== 'string' ||
        !SENSITIVE_DISPOSITIONS.has(
          disposition as SensitivePathCapabilityDisposition,
        )
      ) {
        return errAt(
          `sensitivePaths[${String(index)}].${cap}`,
          `must be one of ${[...SENSITIVE_DISPOSITIONS].join('|')}`,
        );
      }
      parsed[cap] = disposition as SensitivePathCapabilityDisposition;
      hasAtLeastOne = true;
    }
    if (!hasAtLeastOne) {
      return errAt(
        `sensitivePaths[${String(index)}]`,
        'each sensitive-path entry must declare at least one capability disposition',
      );
    }
    out.push(parsed);
  }
  return { kind: 'ok', value: out };
}

export function parseGlobalDenies(raw: unknown): ParseRes<PolicyGlobalDeny[]> {
  if (!Array.isArray(raw)) {
    return errAt('globalDenies', 'globalDenies must be an array');
  }
  const out: PolicyGlobalDeny[] = [];
  for (let i = 0; i < raw.length; i++) {
    const entry = raw[i];
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
      return errAt(`globalDenies[${String(i)}]`, 'entry must be an object');
    }
    const e = entry as Record<string, unknown>;
    const parsed: PolicyGlobalDeny = {};
    if (e['projectId'] !== undefined) {
      if (typeof e['projectId'] !== 'string' || (e['projectId'] as string).length === 0) {
        return errAt(`globalDenies[${String(i)}].projectId`, 'must be a non-empty string');
      }
      parsed.projectId = e['projectId'] as string;
    }
    if (e['principalId'] !== undefined) {
      if (typeof e['principalId'] !== 'string' || (e['principalId'] as string).length === 0) {
        return errAt(`globalDenies[${String(i)}].principalId`, 'must be a non-empty string');
      }
      parsed.principalId = e['principalId'] as string;
    }
    if (e['capability'] !== undefined) {
      const v = e['capability'];
      if (typeof v !== 'string' || !(CAPABILITY_KEYS as readonly string[]).includes(v)) {
        return errAt(
          `globalDenies[${String(i)}].capability`,
          `must be one of ${CAPABILITY_KEYS.join('|')}`,
        );
      }
      parsed.capability = v as 'read' | 'search' | 'write' | 'lock' | 'snapshot';
    }
    if (e['pathPattern'] !== undefined) {
      if (typeof e['pathPattern'] !== 'string' || (e['pathPattern'] as string).length === 0) {
        return errAt(`globalDenies[${String(i)}].pathPattern`, 'must be a non-empty string');
      }
      parsed.pathPattern = e['pathPattern'] as string;
    }
    if (e['reason'] !== undefined) {
      if (typeof e['reason'] !== 'string' || (e['reason'] as string).length === 0) {
        return errAt(`globalDenies[${String(i)}].reason`, 'must be a non-empty string');
      }
      parsed.reason = e['reason'] as string;
    }
    if (
      parsed.projectId === undefined &&
      parsed.principalId === undefined &&
      parsed.capability === undefined &&
      parsed.pathPattern === undefined
    ) {
      return errAt(
        `globalDenies[${String(i)}]`,
        'each globalDenies entry must constrain at least one of projectId|principalId|capability|pathPattern',
      );
    }
    out.push(parsed);
  }
  return { kind: 'ok', value: out };
}

function errAt(field: string, reason: string): ParseRes<never> {
  return { kind: 'err', err: { kind: 'malformed', field, reason } };
}
