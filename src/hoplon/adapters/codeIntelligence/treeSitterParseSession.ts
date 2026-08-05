/**
 * Internal Tree-sitter parse-session helper for t-122.
 *
 * This is an adapter-private performance seam. It never changes public DTOs:
 * callers still receive the same RefinedSyntaxTree facade from parse().
 */

import type { Parser, Point, Tree as TSTree } from 'web-tree-sitter';

export interface TreeSitterParsedState<TTree> {
  readonly result: TTree;
  readonly usedIncremental: boolean;
  readonly changedRangeCount: number;
  readonly fallbackReason: string | null;
}

export interface TreeSitterParseSession<TTree> {
  parse(input: {
    readonly file: string;
    readonly sourceText: string;
    readonly parser: Parser;
    readonly parseFull: () => TSTree;
    readonly buildResult: (tree: TSTree) => TTree;
  }): TreeSitterParsedState<TTree>;
}

interface CachedParse {
  readonly sourceText: string;
  readonly tree: TSTree;
}

export function createTreeSitterParseSession<TTree>(): TreeSitterParseSession<TTree> {
  const cache = new Map<string, CachedParse>();

  return {
    parse(input): TreeSitterParsedState<TTree> {
      const previous = cache.get(input.file);
      const edit = previous
        ? deriveSingleEdit(previous.sourceText, input.sourceText)
        : null;

      if (previous !== undefined && edit !== null) {
        try {
          previous.tree.edit(edit);
          const nextTree = input.parser.parse(input.sourceText, previous.tree);
          if (nextTree !== null) {
            const changedRangeCount =
              typeof previous.tree.getChangedRanges === 'function'
                ? previous.tree.getChangedRanges(nextTree).length
                : 0;
            cache.set(input.file, { sourceText: input.sourceText, tree: nextTree });
            return {
              result: input.buildResult(nextTree),
              usedIncremental: true,
              changedRangeCount,
              fallbackReason: null,
            };
          }
        } catch {
          // Fall through to a full parse. The public result must remain equal
          // to the old behavior when incremental state is unusable.
        }
      }

      const fullTree = input.parseFull();
      cache.set(input.file, { sourceText: input.sourceText, tree: fullTree });
      return {
        result: input.buildResult(fullTree),
        usedIncremental: false,
        changedRangeCount: 0,
        fallbackReason: previous === undefined ? 'missing_previous_tree' : 'unsupported_edit',
      };
    },
  };
}

function deriveSingleEdit(
  oldText: string,
  newText: string,
):
  | {
      startIndex: number;
      oldEndIndex: number;
      newEndIndex: number;
      startPosition: Point;
      oldEndPosition: Point;
      newEndPosition: Point;
    }
  | null {
  if (oldText === newText) return null;

  let prefix = 0;
  const maxPrefix = Math.min(oldText.length, newText.length);
  while (prefix < maxPrefix && oldText[prefix] === newText[prefix]) {
    prefix += 1;
  }

  let oldSuffix = oldText.length;
  let newSuffix = newText.length;
  while (
    oldSuffix > prefix &&
    newSuffix > prefix &&
    oldText[oldSuffix - 1] === newText[newSuffix - 1]
  ) {
    oldSuffix -= 1;
    newSuffix -= 1;
  }

  if (!isAscii(oldText) || !isAscii(newText)) {
    return null;
  }

  return {
    startIndex: prefix,
    oldEndIndex: oldSuffix,
    newEndIndex: newSuffix,
    startPosition: pointForIndex(oldText, prefix),
    oldEndPosition: pointForIndex(oldText, oldSuffix),
    newEndPosition: pointForIndex(newText, newSuffix),
  };
}

function pointForIndex(text: string, index: number): Point {
  let row = 0;
  let column = 0;
  for (let i = 0; i < index; i += 1) {
    if (text[i] === '\n') {
      row += 1;
      column = 0;
    } else {
      column += 1;
    }
  }
  return { row, column };
}

function isAscii(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    if (text.charCodeAt(i) > 0x7f) return false;
  }
  return true;
}
