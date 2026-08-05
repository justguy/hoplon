import type { SignatureParam } from '../contracts/manifest.js';

export interface SignatureNode {
  kind: string;
  namedChildren: SignatureNode[];
  children: SignatureNode[];
  text: string;
}

export interface ParsedSignatureParam {
  name: string;
  typeText: string;
  optional: boolean;
  hasGeneric: boolean;
}

export function findFunctionNodes(
  root: SignatureNode,
  symbolName: string,
): SignatureNode[] {
  const results: SignatureNode[] = [];
  for (const child of root.namedChildren) {
    const unwrapped = unwrapExport(child);
    if (unwrapped === null) continue;
    const { node, kind } = unwrapped;
    if (kind === 'function_declaration' || kind === 'function_signature') {
      if (extractFunctionName(node) === symbolName) results.push(node);
    } else if (kind === 'lexical_declaration' || kind === 'variable_declaration') {
      if (extractArrowFunctionName(node) === symbolName) {
        const arrowBody = findArrowFunctionNode(node);
        if (arrowBody !== null) results.push(arrowBody);
      }
    }
  }
  return results;
}

function unwrapExport(
  node: SignatureNode,
): { node: SignatureNode; kind: string } | null {
  if (node.kind === 'export_statement') {
    for (const child of node.namedChildren) {
      if (isSupportedDeclaration(child.kind)) {
        return { node: child, kind: child.kind };
      }
    }
    return null;
  }
  return isSupportedDeclaration(node.kind) ? { node, kind: node.kind } : null;
}

function isSupportedDeclaration(kind: string): boolean {
  return (
    kind === 'function_declaration' ||
    kind === 'function_signature' ||
    kind === 'lexical_declaration' ||
    kind === 'variable_declaration'
  );
}

function extractFunctionName(node: SignatureNode): string | null {
  for (const child of node.namedChildren) {
    if (child.kind === 'identifier' || child.kind === 'type_identifier') {
      return child.text;
    }
  }
  return null;
}

function extractArrowFunctionName(node: SignatureNode): string | null {
  for (const child of node.namedChildren) {
    if (child.kind === 'variable_declarator') {
      return child.namedChildren[0]?.text ?? null;
    }
  }
  return null;
}

function findArrowFunctionNode(node: SignatureNode): SignatureNode | null {
  for (const child of node.namedChildren) {
    if (child.kind !== 'variable_declarator') continue;
    for (const candidate of child.namedChildren) {
      if (candidate.kind === 'arrow_function' || candidate.kind === 'function') {
        return candidate;
      }
    }
  }
  return null;
}

export function hasTypeParameters(node: SignatureNode): boolean {
  return (
    node.namedChildren.some((child) => child.kind === 'type_parameters') ||
    node.children.some((child) => child.kind === 'type_parameters')
  );
}

export function extractParamNodes(node: SignatureNode): SignatureNode[] | null {
  for (const child of node.namedChildren) {
    if (child.kind === 'formal_parameters') return child.namedChildren;
  }
  for (const child of node.children) {
    if (child.kind === 'formal_parameters') return child.namedChildren;
  }
  return null;
}

export function stringifyExpectedParams(params: ReadonlyArray<SignatureParam>): string {
  return params
    .map((param) => `${param.name}${param.optional ? '?' : ''}: ${param.type}`)
    .join(', ');
}

export function stringifyActualParams(paramNodes: SignatureNode[]): string {
  return paramNodes.map((param) => param.text).join(', ');
}

export function parseParamNode(node: SignatureNode): ParsedSignatureParam | null {
  const kind = node.kind;
  if (kind === 'object_pattern' || kind === 'array_pattern') return null;

  if (kind === 'required_parameter' || kind === 'optional_parameter') {
    const patternNode = node.namedChildren[0];
    const typeAnnotation = node.namedChildren.find(
      (child) => child.kind === 'type_annotation',
    );
    const name = patternNode
      ? patternNode.text.replace('?', '')
      : node.text.replace('?', '');
    const typeText = typeAnnotation
      ? typeAnnotation.text.replace(/^:\s*/, '').trim()
      : '';
    return {
      name,
      typeText,
      optional: kind === 'optional_parameter',
      hasGeneric: typeHasGeneric(typeText),
    };
  }

  if (kind === 'rest_element' || kind === 'rest_pattern') {
    return { name: node.text, typeText: '', optional: false, hasGeneric: false };
  }
  if (kind === 'identifier') {
    return { name: node.text, typeText: '', optional: false, hasGeneric: false };
  }
  if (kind === 'assignment_pattern') {
    return {
      name: node.namedChildren[0]?.text ?? node.text,
      typeText: '',
      optional: true,
      hasGeneric: false,
    };
  }
  return null;
}

function typeHasGeneric(typeText: string): boolean {
  return /[<>]/.test(typeText) || /^[A-Z]$/.test(typeText.trim());
}
