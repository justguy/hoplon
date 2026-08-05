import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import type { ASTStrategy } from '../contracts/astStrategy.js';
import type { PackedSlice } from '../contracts/context.js';

export function applyPackStrategy(
  path: string,
  content: Uint8Array,
  tree: RefinedSyntaxTree,
  strategy: ASTStrategy,
  codeIntelligence: CodeIntelligenceAdapter,
): PackedSlice[] {
  if (strategy.kind === 'whole_file') {
    return applyWholeFileStrategy(path, content, tree);
  }
  if (strategy.kind === 'symbols') {
    return applySymbolsStrategy(
      path,
      content,
      tree,
      strategy.symbols,
      codeIntelligence,
    );
  }
  return applyWholeFileStrategy(path, content, tree);
}

function applyWholeFileStrategy(
  path: string,
  content: Uint8Array,
  tree: RefinedSyntaxTree,
): PackedSlice[] {
  return [
    {
      path,
      byteRange: [0, content.byteLength],
      nodeKinds: [tree.rootNode.kind].sort(),
      content: decodeSlice(content, 0, content.byteLength),
    },
  ];
}

function applySymbolsStrategy(
  path: string,
  content: Uint8Array,
  tree: RefinedSyntaxTree,
  requestedSymbols: string[],
  codeIntelligence: CodeIntelligenceAdapter,
): PackedSlice[] {
  const requested = new Set(requestedSymbols);
  const matched = codeIntelligence
    .getTopLevelSymbols(tree)
    .filter((symbol) => requested.has(symbol.name));
  matched.sort((left, right) => left.byteRange[0] - right.byteRange[0]);
  return matched.map((symbol) => ({
    path,
    byteRange: symbol.byteRange,
    nodeKinds: [symbol.kind].sort(),
    content: decodeSlice(content, symbol.byteRange[0], symbol.byteRange[1]),
  }));
}

function decodeSlice(content: Uint8Array, start: number, end: number): string {
  return new TextDecoder('utf-8').decode(content.subarray(start, end));
}
