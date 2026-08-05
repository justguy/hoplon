import type {
  VersioningBranchResolution,
  VersioningSourceRef,
} from '../adapters/versioning.js';
import { AdapterError } from '../contracts/errors.js';
import type { SemanticCorpusDocument } from '../contracts/semanticSearch.js';
import type {
  ResolvedSemanticSourceRef,
  SemanticRefIndexingDeps,
  SemanticRefIndexingRequest,
} from './semanticRefIndexingModel.js';

export async function resolveSemanticSourceRefs(
  deps: SemanticRefIndexingDeps,
  req: SemanticRefIndexingRequest,
  existingDocs: readonly SemanticCorpusDocument[],
): Promise<ResolvedSemanticSourceRef[]> {
  const [current, defaultBranch] = await Promise.all([
    deps.versioning.resolveCurrentBranch(deps.root),
    deps.versioning.resolveDefaultBranch(deps.root),
  ]);
  const local = await deps.versioning.listLocalBranches(deps.root);
  const remote = await deps.versioning.listRemoteTrackingBranches(deps.root);
  const inventory = [...local, ...remote].map((ref) =>
    enrichRef(ref, current, defaultBranch),
  );
  const scope = req.branchScope;
  if (scope.mode === 'current') {
    return current === null ? [] : [enrichBranch(current, true, defaultBranch)];
  }
  if (scope.mode === 'default') {
    return defaultBranch === null
      ? []
      : [enrichBranch(defaultBranch, current?.name === defaultBranch.name, defaultBranch)];
  }
  if (scope.mode === 'all_local_branches') {
    return inventory.filter((ref) => ref.kind === 'local_branch');
  }
  if (scope.mode === 'all_remote_tracking_branches') {
    return inventory.filter((ref) => ref.kind === 'remote_tracking_branch');
  }
  if (scope.mode === 'patterns') {
    const patterns = scope.patterns ?? [];
    return inventory.filter((ref) =>
      patterns.some((pattern) => refMatchesPattern(ref, pattern)),
    );
  }
  if (scope.mode === 'all_indexed') {
    return indexedAliasRefs(existingDocs, inventory);
  }
  const resolved: ResolvedSemanticSourceRef[] = [];
  for (const ref of scope.refs ?? []) {
    const match = inventory.find((candidate) => refMatchesName(candidate, ref));
    resolved.push(match ?? (await resolveExplicitRef(deps, ref, current, defaultBranch)));
  }
  return dedupeSemanticRefs(resolved);
}

export function groupRefsByCommit(
  refs: readonly ResolvedSemanticSourceRef[],
): Map<string, ResolvedSemanticSourceRef[]> {
  const byCommit = new Map<string, ResolvedSemanticSourceRef[]>();
  for (const ref of dedupeSemanticRefs(refs)) {
    const group = byCommit.get(ref.oid) ?? [];
    group.push(ref);
    byCommit.set(ref.oid, group);
  }
  return byCommit;
}

export function groupExistingByCommit(
  docs: readonly SemanticCorpusDocument[],
): Map<string, SemanticCorpusDocument[]> {
  const byCommit = new Map<string, SemanticCorpusDocument[]>();
  for (const doc of docs) {
    const commitOid = doc.sourceSnapshot?.commitOid;
    if (commitOid === undefined) continue;
    const group = byCommit.get(commitOid) ?? [];
    group.push(doc);
    byCommit.set(commitOid, group);
  }
  return byCommit;
}

function indexedAliasRefs(
  docs: readonly SemanticCorpusDocument[],
  inventory: readonly ResolvedSemanticSourceRef[],
): ResolvedSemanticSourceRef[] {
  const refs: ResolvedSemanticSourceRef[] = [];
  for (const doc of docs) {
    for (const alias of doc.branchAliases ?? []) {
      const match = inventory.find(
        (ref) => ref.kind === alias.branchKind && ref.name === alias.branchName,
      );
      if (match !== undefined) refs.push(match);
    }
  }
  return dedupeSemanticRefs(refs);
}

function enrichRef(
  ref: VersioningSourceRef,
  current: VersioningBranchResolution | null,
  defaultBranch: VersioningBranchResolution | null,
): ResolvedSemanticSourceRef {
  return {
    kind: ref.kind,
    name: ref.name,
    fullRef: ref.fullRef,
    oid: ref.oid,
    ...(ref.remote === undefined ? {} : { remote: ref.remote }),
    isCurrent: current?.oid === ref.oid && current.name === ref.name,
    isDefault: defaultBranch?.oid === ref.oid && defaultBranch.name === ref.name,
  };
}

function enrichBranch(
  branch: VersioningBranchResolution,
  isCurrent: boolean,
  defaultBranch: VersioningBranchResolution | null,
): ResolvedSemanticSourceRef {
  return {
    kind: 'local_branch',
    name: branch.name,
    fullRef: branch.fullRef,
    oid: branch.oid,
    isCurrent,
    isDefault: defaultBranch?.name === branch.name && defaultBranch.oid === branch.oid,
  };
}

async function resolveExplicitRef(
  deps: SemanticRefIndexingDeps,
  ref: string,
  current: VersioningBranchResolution | null,
  defaultBranch: VersioningBranchResolution | null,
): Promise<ResolvedSemanticSourceRef> {
  try {
    const oid = await deps.versioning.resolveRef(deps.root, ref);
    const remotePrefix = 'refs/remotes/';
    const localPrefix = 'refs/heads/';
    const isRemote = ref.startsWith(remotePrefix);
    const name = isRemote ? ref.replace(remotePrefix, '') : ref.replace(localPrefix, '');
    const remote = isRemote ? name.split('/')[0] : undefined;
    return {
      kind: isRemote ? 'remote_tracking_branch' : 'local_branch',
      name,
      fullRef: isRemote || ref.startsWith(localPrefix) ? ref : `refs/heads/${ref}`,
      oid,
      ...(remote === undefined ? {} : { remote }),
      isCurrent: current?.name === name && current.oid === oid,
      isDefault: defaultBranch?.name === name && defaultBranch.oid === oid,
    };
  } catch (err) {
    if (err instanceof AdapterError) throw err;
    throw new AdapterError(
      { kind: 'git_read_failed', engineId: deps.engineId, correlationId: reqId(ref), cause: err },
      `Failed to resolve source ref '${ref}'`,
    );
  }
}

function refMatchesName(ref: ResolvedSemanticSourceRef, input: string): boolean {
  return ref.name === input || ref.fullRef === input;
}

function refMatchesPattern(ref: ResolvedSemanticSourceRef, pattern: string): boolean {
  const re = new RegExp(`^${globToRegex(pattern)}$`, 'u');
  return re.test(ref.name) || re.test(ref.fullRef);
}

function globToRegex(pattern: string): string {
  let out = '';
  for (const ch of pattern) {
    if (ch === '*') out += '.*';
    else if (ch === '?') out += '.';
    else out += /[\^$+?.()|{}[\]]/u.test(ch) ? `\\${ch}` : ch;
  }
  return out;
}

function dedupeSemanticRefs(
  refs: readonly ResolvedSemanticSourceRef[],
): ResolvedSemanticSourceRef[] {
  const byKey = new Map<string, ResolvedSemanticSourceRef>();
  for (const ref of refs) byKey.set(ref.fullRef, ref);
  return [...byKey.values()].sort((a, b) => a.fullRef.localeCompare(b.fullRef));
}

function reqId(ref: string): string {
  return `semantic-ref-indexing:${ref}`;
}
