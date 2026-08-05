import type { SemanticSearchMatch } from '../contracts/semanticSearch.js';

const RRF_SOURCE_CANDIDATE_FLOOR = 50;

const RANK_SOURCE_ORDER = {
  overlay_lexical: 0,
  overlay_vector: 1,
  baseline_lexical: 2,
  baseline_vector: 3,
} as const;

export type SemanticRankSource = NonNullable<SemanticSearchMatch['rankSource']>;

export interface SemanticRawRankMatch {
  readonly id: string;
  readonly score: number;
  readonly metadata: SemanticSearchMatch['metadata'];
  readonly sourceSnapshot?: SemanticSearchMatch['sourceSnapshot'] | undefined;
  readonly branchAliases?:
    | readonly NonNullable<SemanticSearchMatch['branchAliases']>[number][]
    | undefined;
  readonly chunkIdentity?: SemanticSearchMatch['chunkIdentity'] | undefined;
}

export interface RankedSemanticCandidate {
  readonly match: SemanticSearchMatch;
  readonly rank: number;
  readonly rankSource: SemanticRankSource;
}

export function sourceCandidateLimit(topK: number): number {
  return Math.max(topK, RRF_SOURCE_CANDIDATE_FLOOR);
}

export function rankAuthorizedMatches(args: {
  readonly projectId: string;
  readonly matches: readonly SemanticRawRankMatch[];
  readonly source: NonNullable<SemanticSearchMatch['source']>;
  readonly rankSource: SemanticRankSource;
  readonly freshness: NonNullable<SemanticSearchMatch['freshness']>;
}): {
  readonly candidates: RankedSemanticCandidate[];
  readonly unauthorizedRowsFiltered: boolean;
} {
  const candidates: RankedSemanticCandidate[] = [];
  let unauthorizedRowsFiltered = false;
  for (const match of args.matches) {
    if (!isAuthorizedForProject(args.projectId, match.metadata)) {
      unauthorizedRowsFiltered = true;
      continue;
    }
    const rankedMatch: SemanticSearchMatch = {
      id: match.id,
      score: clampScore(match.score),
      metadata: match.metadata,
      source: args.source,
      rankSource: args.rankSource,
      freshness: args.freshness,
      ...(match.sourceSnapshot === undefined ? {} : { sourceSnapshot: match.sourceSnapshot }),
      ...(match.branchAliases === undefined ? {} : { branchAliases: [...match.branchAliases] }),
      ...(match.chunkIdentity === undefined ? {} : { chunkIdentity: match.chunkIdentity }),
    };
    candidates.push({
      rank: candidates.length + 1,
      rankSource: args.rankSource,
      match: rankedMatch,
    });
  }
  return { candidates, unauthorizedRowsFiltered };
}

export function fuseRrfMatches(
  candidates: readonly RankedSemanticCandidate[],
): SemanticSearchMatch[] {
  const byId = new Map<string, {
    match: SemanticSearchMatch;
    score: number;
    primaryRank: number;
    primarySourceOrder: number;
  }>();
  for (const candidate of candidates) {
    const sourceOrder = RANK_SOURCE_ORDER[candidate.rankSource];
    const contribution = candidate.match.score;
    const key = dedupeKey(candidate.match);
    const existing = byId.get(key);
    if (existing === undefined) {
      byId.set(key, {
        match: { ...candidate.match, score: contribution },
        score: contribution,
        primaryRank: candidate.rank,
        primarySourceOrder: sourceOrder,
      });
      continue;
    }
    existing.score = Math.max(existing.score, contribution);
    existing.match.score = existing.score;
    const mergedAliases = mergeBranchAliases(
      existing.match.branchAliases,
      candidate.match.branchAliases,
    );
    existing.match.branchAliases = mergedAliases;
    if (
      sourceOrder < existing.primarySourceOrder ||
      (sourceOrder === existing.primarySourceOrder && candidate.rank < existing.primaryRank)
    ) {
      existing.match = { ...candidate.match, score: existing.score };
      existing.match.branchAliases = mergedAliases;
      existing.primaryRank = candidate.rank;
      existing.primarySourceOrder = sourceOrder;
    }
  }
  return [...byId.values()]
    .map((entry) => entry.match)
    .sort(compareFusedMatches);
}

function isAuthorizedForProject(
  projectId: string,
  metadata: SemanticSearchMatch['metadata'],
): boolean {
  const metadataProjectId = metadata.projectId;
  return metadataProjectId === undefined || metadataProjectId === projectId;
}

function compareFusedMatches(
  left: SemanticSearchMatch,
  right: SemanticSearchMatch,
): number {
  if (right.score !== left.score) return right.score - left.score;
  const branchCompare = branchPriority(left) - branchPriority(right);
  if (branchCompare !== 0) return branchCompare;
  const leftOrder = RANK_SOURCE_ORDER[left.rankSource ?? 'baseline_vector'];
  const rightOrder = RANK_SOURCE_ORDER[right.rankSource ?? 'baseline_vector'];
  if (leftOrder !== rightOrder) return leftOrder - rightOrder;
  const leftPath = typeof left.metadata.path === 'string' ? left.metadata.path : '';
  const rightPath = typeof right.metadata.path === 'string' ? right.metadata.path : '';
  const pathCompare = leftPath.localeCompare(rightPath);
  if (pathCompare !== 0) return pathCompare;
  return left.id.localeCompare(right.id);
}

function dedupeKey(match: SemanticSearchMatch): string {
  const chunk = match.chunkIdentity;
  if (chunk !== undefined) {
    return [
      'chunk',
      chunk.projectId,
      chunk.canonicalPath,
      chunk.contentHash,
      chunk.chunkHash,
      String(chunk.chunkIndex),
    ].join(':');
  }
  return `id:${match.id}`;
}

function mergeBranchAliases(
  left: SemanticSearchMatch['branchAliases'],
  right: SemanticSearchMatch['branchAliases'],
): SemanticSearchMatch['branchAliases'] {
  if (left === undefined) return right === undefined ? undefined : [...right];
  if (right === undefined) return [...left];
  const byKey = new Map<string, NonNullable<SemanticSearchMatch['branchAliases']>[number]>();
  for (const alias of left) byKey.set(`${alias.branchKind}:${alias.branchName}`, alias);
  for (const alias of right) byKey.set(`${alias.branchKind}:${alias.branchName}`, alias);
  return [...byKey.values()].sort((a, b) =>
    `${a.branchKind}:${a.branchName}`.localeCompare(`${b.branchKind}:${b.branchName}`),
  );
}

function branchPriority(match: SemanticSearchMatch): number {
  const aliases = match.branchAliases ?? [];
  if (aliases.some((alias) => alias.isCurrent && alias.staleState === 'fresh')) return 0;
  if (aliases.some((alias) => alias.isDefault && alias.staleState === 'fresh')) return 1;
  if (aliases.some((alias) => alias.staleState === 'fresh')) return 2;
  return aliases.length > 0 ? 3 : 4;
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(1, score));
}
