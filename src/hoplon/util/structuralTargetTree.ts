import type { Symbol, SyntaxTree } from '../adapters/codeIntelligence.js';

export interface StructuralTargetMatch extends Symbol {
  readonly path: readonly string[];
}

interface RefinedLikeNode {
  kind: string;
  byteRange?: [number, number];
  namedChildren?: RefinedLikeNode[];
  children?: unknown[];
}

interface RefinedWithText extends RefinedLikeNode {
  text?: string;
}

export function resolveSymbolPathMatches(
  tree: SyntaxTree,
  symbolPath: readonly string[],
): StructuralTargetMatch[] {
  if (symbolPath.length === 0) return [];
  return collectStructuralTargetMatches(tree).filter((match) =>
    structuralPathsEqual(match.path, symbolPath),
  );
}

export function collectStructuralTargetMatches(
  tree: SyntaxTree,
): StructuralTargetMatch[] {
  const results: StructuralTargetMatch[] = [];
  const root = tree.rootNode as unknown as RefinedLikeNode;
  collectNamedDeclarations(root, [], results);
  return results;
}

export function isStrictStructuralPathAncestor(
  candidate: readonly string[],
  target: readonly string[],
): boolean {
  return (
    candidate.length < target.length &&
    candidate.every((segment, index) => segment === target[index])
  );
}

function structuralPathsEqual(
  left: readonly string[],
  right: readonly string[],
): boolean {
  return (
    left.length === right.length &&
    left.every((segment, index) => segment === right[index])
  );
}

function collectNamedDeclarations(
  node: RefinedLikeNode,
  ancestorPath: readonly string[],
  out: StructuralTargetMatch[],
): void {
  const namedChildren = Array.isArray(node.namedChildren) ? node.namedChildren : [];
  for (const child of namedChildren) {
    const name = extractDeclaredName(child);
    if (name !== null && !isTransparentNamedWrapper(child.kind)) {
      const path = [...ancestorPath, name];
      if (child.byteRange) {
        out.push({
          name,
          kind: child.kind,
          byteRange: child.byteRange,
          path,
        });
      }
      collectNamedDeclarations(child, path, out);
      continue;
    }
    collectNamedDeclarations(child, ancestorPath, out);
  }
}

function isTransparentNamedWrapper(kind: string): boolean {
  return kind === 'export_statement';
}

function extractDeclaredName(node: RefinedLikeNode): string | null {
  if (!Array.isArray(node.namedChildren) || node.namedChildren.length === 0) {
    return null;
  }
  switch (node.kind) {
    case 'function_declaration':
    case 'generator_function_declaration':
    case 'method_definition':
    case 'function_signature':
    case 'method_signature': {
      for (const child of node.namedChildren) {
        if (
          child.kind === 'identifier' ||
          child.kind === 'type_identifier' ||
          child.kind === 'property_identifier'
        ) {
          return (child as RefinedWithText).text ?? null;
        }
      }
      return null;
    }
    case 'class_declaration':
    case 'interface_declaration':
    case 'type_alias_declaration':
    case 'enum_declaration':
    case 'abstract_class_declaration': {
      for (const child of node.namedChildren) {
        if (child.kind === 'type_identifier' || child.kind === 'identifier') {
          return (child as RefinedWithText).text ?? null;
        }
      }
      return null;
    }
    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const child of node.namedChildren) {
        if (child.kind === 'variable_declarator') {
          const first = Array.isArray(child.namedChildren)
            ? child.namedChildren[0]
            : undefined;
          return first ? (first as RefinedWithText).text ?? null : null;
        }
      }
      return null;
    }
    case 'export_statement': {
      for (const child of node.namedChildren) {
        const inner = extractDeclaredName(child);
        if (inner !== null) return inner;
      }
      return null;
    }
    default:
      return null;
  }
}
