import type { Node as TSNode } from 'web-tree-sitter';
import type { SyntaxTree, Symbol } from '../codeIntelligence.js';
import type { TreeSitterSupportedLanguage } from './treeSitterLimits.js';

export interface RefinedSyntaxNode {
  kind: string;
  byteRange: [number, number];
  text: string;
  children: RefinedSyntaxNode[];
  namedChildren: RefinedSyntaxNode[];
}

export interface RefinedSyntaxTree extends SyntaxTree {
  rootNode: RefinedSyntaxNode;
  language: 'javascript' | 'typescript' | 'tsx';
  grammarVersion: string;
  /** Raw tree-sitter node reserved for queryStructure.ts. */
  _rawRootNode?: TSNode;
}

const EXT_TO_LANG: ReadonlyMap<string, TreeSitterSupportedLanguage> = new Map([
  ['.js', 'javascript'],
  ['.mjs', 'javascript'],
  ['.cjs', 'javascript'],
  ['.jsx', 'javascript'],
  ['.ts', 'typescript'],
  ['.tsx', 'tsx'],
]);

export function detectLanguage(filePath: string): TreeSitterSupportedLanguage | null {
  const dot = filePath.lastIndexOf('.');
  if (dot === -1) return null;
  return EXT_TO_LANG.get(filePath.slice(dot).toLowerCase()) ?? null;
}

/** Convert a web-tree-sitter UTF-16 position to Hoplon's UTF-8 byte offset. */
export function charPosToBytePos(sourceText: string, charPos: number): number {
  if (charPos >= sourceText.length) return Buffer.byteLength(sourceText, 'utf8');
  if (charPos <= 0) return 0;
  return Buffer.byteLength(sourceText.slice(0, charPos), 'utf8');
}

export function wrapNode(node: TSNode, sourceText: string): RefinedSyntaxNode {
  return {
    kind: node.type,
    byteRange: [
      charPosToBytePos(sourceText, node.startIndex),
      charPosToBytePos(sourceText, node.endIndex),
    ],
    text: node.text,
    get children(): RefinedSyntaxNode[] {
      return node.children
        .filter((child): child is TSNode => child !== null)
        .map((child) => wrapNode(child, sourceText));
    },
    get namedChildren(): RefinedSyntaxNode[] {
      return node.namedChildren
        .filter((child): child is TSNode => child !== null)
        .map((child) => wrapNode(child, sourceText));
    },
  };
}

const TOP_LEVEL_KINDS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'lexical_declaration',
  'variable_declaration',
  'export_statement',
  'import_statement',
]);

export function extractTopLevelSymbolsFromFacade(nodes: RefinedSyntaxNode[]): Symbol[] {
  const symbols: Symbol[] = [];
  for (const node of nodes) {
    if (!TOP_LEVEL_KINDS.has(node.kind)) continue;
    const name = extractNameFromFacade(node);
    if (name !== null) symbols.push({ name, kind: node.kind, byteRange: node.byteRange });
  }
  return symbols;
}

function extractNameFromFacade(node: RefinedSyntaxNode): string | null {
  switch (node.kind) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'class_declaration':
      for (const child of node.namedChildren) {
        if (child.kind === 'identifier' || child.kind === 'type_identifier') return child.text;
      }
      return null;
    case 'lexical_declaration':
    case 'variable_declaration':
      for (const child of node.namedChildren) {
        if (child.kind === 'variable_declarator') return child.namedChildren[0]?.text ?? null;
      }
      return null;
    case 'export_statement':
      for (const child of node.namedChildren) {
        if (
          child.kind === 'function_declaration' ||
          child.kind === 'generator_function_declaration' ||
          child.kind === 'class_declaration' ||
          child.kind === 'lexical_declaration' ||
          child.kind === 'variable_declaration'
        ) return extractNameFromFacade(child);
      }
      return null;
    case 'import_statement':
      for (const child of node.namedChildren) {
        if (child.kind === 'string') return child.text.replace(/^['"`]|['"`]$/g, '');
      }
      return null;
    default:
      return null;
  }
}
