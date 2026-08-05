import type {
  SemanticBranchAlias,
  SemanticCorpusDocument,
  SemanticSearchMatch,
  SemanticSearchRequest,
} from '../contracts/semanticSearch.js';
import type { SemanticSearchDeps } from './semanticSearchShared.js';
import { uniqueReasons } from './semanticSearchPolicy.js';

export interface SemanticSearchSourceIndex {
  readonly docsById: ReadonlyMap<string, SemanticCorpusDocument>;
  readonly degradationReasons: readonly string[];
  readonly unavailableForScopedRequest: boolean;
}

export interface BranchScopedMatchResult<T> {
  readonly matches: T[];
  readonly staleIncluded: boolean;
}

interface BaselineMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: SemanticSearchMatch['metadata'];
  readonly sourceSnapshot?: SemanticSearchMatch['sourceSnapshot'];
  readonly branchAliases?: readonly SemanticBranchAlias[];
  readonly chunkIdentity?: SemanticSearchMatch['chunkIdentity'];
}

export async function readSemanticSearchSourceIndex(
  deps: SemanticSearchDeps,
  request: SemanticSearchRequest,
): Promise<SemanticSearchSourceIndex> {
  if (deps.semanticIndexStoreProvided !== true) {
    return {
      docsById: new Map(),
      degradationReasons: request.branchScope === undefined ? [] : ['provider_not_bound'],
      unavailableForScopedRequest: request.branchScope !== undefined,
    };
  }
  const read = await deps.semanticIndexStore.read(request.projectId);
  return {
    docsById: new Map(
      read.documents.map((doc) => [
        doc.id,
        {
          id: doc.id,
          text: doc.text,
          documentTextHash: doc.contentHash,
          metadata: doc.metadata,
          ...(doc.sourceSnapshot === undefined ? {} : { sourceSnapshot: doc.sourceSnapshot }),
          ...(doc.branchAliases === undefined ? {} : { branchAliases: [...doc.branchAliases] }),
          ...(doc.chunkIdentity === undefined ? {} : { chunkIdentity: doc.chunkIdentity }),
        },
      ]),
    ),
    degradationReasons: read.degradationReasons,
    unavailableForScopedRequest:
      request.branchScope !== undefined && read.status === 'UNAVAILABLE',
  };
}

export function filterBranchScopedBaselineMatches<T extends BaselineMatch>(
  matches: readonly T[],
  request: SemanticSearchRequest,
  sourceIndex: SemanticSearchSourceIndex,
): BranchScopedMatchResult<T> {
  const output: T[] = [];
  let staleIncluded = false;
  for (const match of matches) {
    const enriched = enrichMatch(match, sourceIndex.docsById.get(match.id));
    const aliases = enriched.branchAliases ?? [];
    if (request.branchScope === undefined) {
      if (aliases.some((alias) => alias.staleState === 'stale')) staleIncluded = true;
      output.push(enriched);
      continue;
    }
    const scopedAliases = aliases.filter((alias) => aliasMatchesRequest(alias, request));
    const visibleAliases =
      request.stalePolicy === 'exclude'
        ? scopedAliases.filter((alias) => alias.staleState !== 'stale')
        : scopedAliases;
    if (visibleAliases.length === 0) continue;
    if (visibleAliases.some((alias) => alias.staleState === 'stale')) {
      staleIncluded = true;
    }
    output.push({ ...enriched, branchAliases: visibleAliases } as T);
  }
  return { matches: output, staleIncluded };
}

export function branchScopeReasons(args: {
  readonly sourceIndex: SemanticSearchSourceIndex;
  readonly staleIncluded: boolean;
}): ReturnType<typeof uniqueReasons> {
  return uniqueReasons([
    ...args.sourceIndex.degradationReasons,
    args.staleIncluded ? 'stale_index' : null,
  ]);
}

function enrichMatch<T extends BaselineMatch>(
  match: T,
  sourceDoc: SemanticCorpusDocument | undefined,
): T {
  if (sourceDoc === undefined) return match;
  return {
    ...match,
    metadata: { ...(sourceDoc.metadata ?? {}), ...match.metadata },
    ...(sourceDoc.sourceSnapshot === undefined
      ? {}
      : { sourceSnapshot: sourceDoc.sourceSnapshot }),
    ...(sourceDoc.branchAliases === undefined
      ? {}
      : { branchAliases: [...sourceDoc.branchAliases] }),
    ...(sourceDoc.chunkIdentity === undefined
      ? {}
      : { chunkIdentity: sourceDoc.chunkIdentity }),
  } as T;
}

function aliasMatchesRequest(
  alias: NonNullable<SemanticSearchMatch['branchAliases']>[number],
  request: SemanticSearchRequest,
): boolean {
  const scope = request.branchScope;
  if (scope === undefined || scope.mode === 'all_indexed') return true;
  if (scope.mode === 'current') return alias.isCurrent;
  if (scope.mode === 'default') return alias.isDefault;
  if (scope.mode === 'all_local_branches') return alias.branchKind === 'local_branch';
  if (scope.mode === 'all_remote_tracking_branches') {
    return alias.branchKind === 'remote_tracking_branch';
  }
  if (scope.mode === 'branches') {
    return (scope.refs ?? []).some((ref) => refMatchesAlias(ref, alias));
  }
  return (scope.patterns ?? []).some((pattern) => {
    const re = new RegExp(`^${globToRegex(pattern)}$`, 'u');
    return re.test(alias.branchName);
  });
}

function refMatchesAlias(
  ref: string,
  alias: NonNullable<SemanticSearchMatch['branchAliases']>[number],
): boolean {
  if (ref === alias.branchName) return true;
  if (alias.branchKind === 'local_branch') return ref === `refs/heads/${alias.branchName}`;
  return ref === `refs/remotes/${alias.branchName}`;
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
