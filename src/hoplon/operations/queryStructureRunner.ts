import { Query } from 'web-tree-sitter';
import type { Language } from 'web-tree-sitter';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import type { TreeSitterQuery } from '../contracts/queryStructure.js';
import {
  buildQueryExecutionRecords,
  type QueryExecutionRecords,
} from './queryStructureMatchGroups.js';

export interface CodeIntelligenceAdapterWithLanguages
  extends CodeIntelligenceAdapter {
  _languages?: Record<string, Language>;
}

export interface QueryFailure {
  path: string;
  queryId: string;
  reason:
    | 'file_not_found'
    | 'parse_failure'
    | 'invalid_query'
    | 'unsupported_extension';
  message: string;
}

export function runQuery(
  relPath: string,
  treeSitterQuery: TreeSitterQuery,
  tree: RefinedSyntaxTree,
  sourceText: string,
  languages: Record<string, Language> | undefined,
  failures: QueryFailure[],
): QueryExecutionRecords {
  if (!languages || !languages[treeSitterQuery.language]) {
    failures.push({
      path: relPath,
      queryId: treeSitterQuery.id,
      reason: 'invalid_query',
      message: `Language '${treeSitterQuery.language}' not available in adapter's language registry`,
    });
    return { matches: [], matchGroups: [] };
  }

  let query: Query;
  try {
    query = new Query(
      languages[treeSitterQuery.language]!,
      treeSitterQuery.pattern,
    );
  } catch (error) {
    failures.push({
      path: relPath,
      queryId: treeSitterQuery.id,
      reason: 'invalid_query',
      message: `Invalid S-expression pattern: ${errorMessage(error)}`,
    });
    return { matches: [], matchGroups: [] };
  }

  const rawTree = tree as unknown as {
    _rawRootNode?: unknown;
    _rawTree?: { rootNode?: unknown };
  };
  const rawNode = rawTree._rawRootNode ?? rawTree._rawTree?.rootNode;
  if (!rawNode) {
    failures.push({
      path: relPath,
      queryId: treeSitterQuery.id,
      reason: 'parse_failure',
      message:
        'Tree-sitter raw node not accessible from adapter — queryStructure requires createTreeSitterIntelligence with CI3-3 extensions',
    });
    query.delete();
    return { matches: [], matchGroups: [] };
  }

  let rawMatches: ReturnType<Query['matches']>;
  try {
    rawMatches = query.matches(rawNode as Parameters<Query['matches']>[0]);
  } catch (error) {
    failures.push({
      path: relPath,
      queryId: treeSitterQuery.id,
      reason: 'invalid_query',
      message: `Query execution failed: ${errorMessage(error)}`,
    });
    query.delete();
    return { matches: [], matchGroups: [] };
  }

  query.delete();
  return buildQueryExecutionRecords({
    relPath,
    tsQuery: treeSitterQuery,
    rawMatches,
    sourceText,
  });
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
