import type { Query } from 'web-tree-sitter';
import { charPosToBytePos } from '../adapters/codeIntelligence/treeSitter.js';
import type {
  QueryMatch,
  QueryMatchGroup,
  TreeSitterQuery,
} from '../contracts/queryStructure.js';

type RawQueryMatch = ReturnType<Query['matches']>[number];
type RawQueryCapture = RawQueryMatch['captures'][number];
type RawQueryNode = RawQueryCapture['node'];

export interface QueryExecutionRecords {
  matches: QueryMatch[];
  matchGroups: QueryMatchGroup[];
}

export function buildQueryExecutionRecords(args: {
  relPath: string;
  tsQuery: TreeSitterQuery;
  rawMatches: RawQueryMatch[];
  sourceText: string;
}): QueryExecutionRecords {
  const { relPath, tsQuery, rawMatches, sourceText } = args;
  const matchGroups = rawMatches.map((match, matchIndex) => {
    const patternIndex = match.patternIndex;
    const matchId = buildMatchId(relPath, tsQuery.id, patternIndex, matchIndex);
    const captures = match.captures.map((capture, captureIndex) =>
      buildCapture({
        relPath,
        queryId: tsQuery.id,
        matchId,
        patternIndex,
        captureIndex,
        capture,
        sourceText,
      }),
    );
    return {
      matchId,
      queryId: tsQuery.id,
      path: relPath,
      patternIndex,
      captures,
    };
  });

  return {
    matches: matchGroups.flatMap((group) => group.captures),
    matchGroups,
  };
}

function buildMatchId(
  relPath: string,
  queryId: string,
  patternIndex: number,
  matchIndex: number,
): string {
  return `${relPath}#${queryId}#${patternIndex}#${matchIndex}`;
}

function buildCapture(args: {
  relPath: string;
  queryId: string;
  matchId: string;
  patternIndex: number;
  captureIndex: number;
  capture: RawQueryCapture;
  sourceText: string;
}): QueryMatch {
  const fieldPath = collectFieldPath(args.capture.node);
  return {
    queryId: args.queryId,
    path: args.relPath,
    captureName: args.capture.name,
    text: args.capture.node.text,
    byteRange: [
      charPosToBytePos(args.sourceText, args.capture.node.startIndex),
      charPosToBytePos(args.sourceText, args.capture.node.endIndex),
    ],
    nodeKind: args.capture.node.type,
    matchId: args.matchId,
    patternIndex: args.patternIndex,
    captureIndex: args.captureIndex,
    ...(fieldPath.length > 0
      ? { fieldName: fieldPath[fieldPath.length - 1]!, fieldPath }
      : {}),
  };
}

function collectFieldPath(node: RawQueryNode): string[] {
  const fieldPath: string[] = [];
  let current: RawQueryNode = node;
  let parent = current.parent;
  while (parent !== null) {
    const fieldName = findFieldName(parent, current);
    if (fieldName !== undefined) {
      fieldPath.unshift(fieldName);
    }
    current = parent;
    parent = current.parent;
  }
  return fieldPath;
}

function findFieldName(parent: RawQueryNode, child: RawQueryNode): string | undefined {
  for (let index = 0; index < parent.childCount; index += 1) {
    const candidate = parent.child(index);
    if (candidate !== null && candidate.equals(child)) {
      return parent.fieldNameForChild(index) ?? undefined;
    }
  }
  return undefined;
}
