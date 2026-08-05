import type { Node as TSNode } from 'web-tree-sitter';

type SupportedLanguage = 'javascript' | 'typescript' | 'tsx';

export interface SerializedNode {
  kind: string;
  byteRange: [number, number];
  text: string;
  childIndexes: number[];
  namedChildIndexes: number[];
}

export interface SerializedSyntaxTree {
  rootKind: string;
  rootByteRange: [number, number];
  rootText: string;
  nodes: SerializedNode[];
  language: SupportedLanguage;
  grammarVersion: string;
}

function charPosToBytePos(sourceText: string, charPos: number): number {
  if (charPos >= sourceText.length) {
    return Buffer.byteLength(sourceText, 'utf8');
  }
  if (charPos <= 0) return 0;
  return Buffer.byteLength(sourceText.slice(0, charPos), 'utf8');
}

/** Serialize a tree-sitter tree into the worker protocol's flat node array. */
export function serializeTree(
  root: TSNode,
  sourceText: string,
): { nodes: SerializedNode[]; rootIndex: number } {
  const nodes: SerializedNode[] = [];

  function visit(node: TSNode): number {
    const index = nodes.length;
    nodes.push({
      kind: '',
      byteRange: [0, 0],
      text: '',
      childIndexes: [],
      namedChildIndexes: [],
    });

    const childIndexes: number[] = [];
    const namedChildIndexes: number[] = [];
    for (let i = 0; i < node.childCount; i++) {
      const child = node.child(i);
      if (child !== null) {
        const childIndex = visit(child);
        childIndexes.push(childIndex);
        if (child.isNamed) namedChildIndexes.push(childIndex);
      }
    }

    nodes[index] = {
      kind: node.type,
      byteRange: [
        charPosToBytePos(sourceText, node.startIndex),
        charPosToBytePos(sourceText, node.endIndex),
      ],
      text: node.text,
      childIndexes,
      namedChildIndexes,
    };
    return index;
  }

  const rootIndex = visit(root);
  return { nodes, rootIndex };
}
