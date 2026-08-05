import type {
  SemanticSearchRequest,
  SemanticSearchSuggestion,
} from '../contracts/semanticSearch.js';
import type { SemanticSearchSourceIndex } from './semanticSearchBranchScope.js';

export function liveSessionRecoverySuggestions(): SemanticSearchSuggestion[] {
  return [
    {
      kind: 'live_session_overlay_missing',
      message:
        'Run refresh_semantic_overlay for this session, then retry with sessionId.',
      provenance: 'deterministic',
    },
    {
      kind: 'indexed_search',
      message:
        'Use freshness=indexed when live-session overlay bytes are not required.',
      provenance: 'deterministic',
    },
  ];
}

export function indexedRecoverySuggestions(): SemanticSearchSuggestion[] {
  return [
    {
      kind: 'provider_binding',
      message:
        'Bind a semantic provider for this runtime before indexed semantic_search can return matches.',
      provenance: 'deterministic',
    },
    {
      kind: 'no_indexed_corpus',
      message:
        'No indexed semantic corpus is available for this project.',
      provenance: 'deterministic',
    },
    {
      kind: 'corpus_indexing',
      message:
        'Index a project corpus explicitly before retrying indexed semantic_search.',
      provenance: 'deterministic',
    },
  ];
}

export function buildSemanticSearchSuggestions(args: {
  readonly request: SemanticSearchRequest;
  readonly sourceIndex: SemanticSearchSourceIndex;
  readonly resultCount: number;
  readonly staleIncluded: boolean;
}): SemanticSearchSuggestion[] {
  const suggestions: SemanticSearchSuggestion[] = [];
  if (args.sourceIndex.docsById.size === 0) {
    suggestions.push({
      kind: 'no_indexed_corpus',
      message: 'No source-indexed corpus is available for branch-aware search.',
      provenance: 'deterministic',
    });
    return suggestions;
  }
  if (args.staleIncluded) {
    suggestions.push({
      kind: 'stale_index',
      message: 'Some returned branch aliases are stale; use stalePolicy=exclude or refresh explicitly.',
      provenance: 'deterministic',
    });
  }
  if (args.resultCount > 0) return suggestions;
  suggestions.push(...branchSuggestions(args.request, args.sourceIndex));
  if (args.request.query.trim().length < 3) {
    suggestions.push({
      kind: 'query',
      message: 'Query is very short; add a symbol, path fragment, or behavior phrase.',
      provenance: 'deterministic',
    });
  }
  return suggestions;
}

function branchSuggestions(
  request: SemanticSearchRequest,
  sourceIndex: SemanticSearchSourceIndex,
): SemanticSearchSuggestion[] {
  const scope = request.branchScope;
  if (scope === undefined) return [];
  const aliases = indexedBranchNames(sourceIndex);
  if (scope.mode === 'patterns') {
    return (scope.patterns ?? []).flatMap((pattern) =>
      aliases.some((alias) => globMatch(alias, pattern))
        ? []
        : [{
            kind: 'pattern' as const,
            value: pattern,
            message: `No indexed branch aliases matched pattern '${pattern}'.`,
            provenance: 'deterministic' as const,
          }],
    );
  }
  if (scope.mode !== 'branches') return [];
  return (scope.refs ?? []).flatMap((ref) => {
    const input = ref.replace(/^refs\/heads\//, '').replace(/^refs\/remotes\//, '');
    if (aliases.includes(input)) return [];
    const suggested = aliases.find((alias) => isOneEditOrPrefix(input, alias));
    return [{
      kind: 'branch' as const,
      value: suggested ?? input,
      message: suggested === undefined
        ? `No indexed branch alias matched '${ref}'.`
        : `No indexed branch alias matched '${ref}'. Did you mean '${suggested}'?`,
      provenance: 'deterministic' as const,
    }];
  });
}

function indexedBranchNames(sourceIndex: SemanticSearchSourceIndex): string[] {
  const names = new Set<string>();
  for (const doc of sourceIndex.docsById.values()) {
    for (const alias of doc.branchAliases ?? []) names.add(alias.branchName);
  }
  return [...names].sort();
}

function globMatch(value: string, pattern: string): boolean {
  const re = new RegExp(`^${globToRegex(pattern)}$`, 'u');
  return re.test(value);
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

function isOneEditOrPrefix(input: string, candidate: string): boolean {
  if (candidate.startsWith(input) || input.startsWith(candidate)) return true;
  if (Math.abs(input.length - candidate.length) > 1) return false;
  let edits = 0;
  for (let i = 0, j = 0; i < input.length && j < candidate.length; i += 1, j += 1) {
    if (input[i] === candidate[j]) continue;
    edits += 1;
    if (edits > 1) return false;
    if (input.length > candidate.length) j -= 1;
    if (candidate.length > input.length) i -= 1;
  }
  return true;
}
