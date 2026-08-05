import { createHash } from 'node:crypto';

import type {
  CodeIntelligenceAdapter,
  SyntaxTree,
} from '../adapters/codeIntelligence.js';
import { AdapterError } from '../contracts/errors.js';
import type {
  DeclarativeInvariantBinding,
  InvariantAstTarget,
  InvariantCheckReason,
  InvariantCheckResult,
  InvariantNodeProvenance,
} from '../contracts/invariantBinding.js';
import type { MaterializedDryRunChange } from './dryRunMaterializeChanges.js';

export interface RefinedNode {
  readonly kind: string;
  readonly text?: string;
  readonly byteRange?: [number, number];
  readonly namedChildren?: readonly RefinedNode[];
}

export interface ResolvedTargetNode {
  readonly node: RefinedNode;
  readonly provenance: InvariantNodeProvenance;
}

export interface ParsedPreviewFile {
  readonly path: string;
  readonly bytes: Uint8Array;
  readonly tree: SyntaxTree;
}

export function invariantResult(
  invariant: DeclarativeInvariantBinding,
  status: InvariantCheckResult['status'],
  reason: InvariantCheckReason,
  message: string,
  provenance: InvariantNodeProvenance | null,
): InvariantCheckResult {
  return {
    invariantId: invariant.id,
    invariantKind: invariant.kind,
    status,
    reason,
    message,
    blocking: false,
    provenance,
  };
}

export async function resolveInvariantTarget(input: {
  readonly target: InvariantAstTarget;
  readonly invariant: DeclarativeInvariantBinding;
  readonly files: ReadonlyMap<string, MaterializedDryRunChange>;
  readonly parsedFiles: Map<string, ParsedPreviewFile | InvariantCheckResult>;
  readonly codeIntelligence: CodeIntelligenceAdapter;
  readonly signal?: AbortSignal | undefined;
}): Promise<ResolvedTargetNode | InvariantCheckResult> {
  const parsed = await parsePreviewFile({
    file: input.target.file,
    invariant: input.invariant,
    files: input.files,
    parsedFiles: input.parsedFiles,
    codeIntelligence: input.codeIntelligence,
    signal: input.signal,
  });
  if ('status' in parsed) return parsed;

  const matches = collectDeclarationNodes(parsed.tree).filter((node) =>
    pathsEqual(node.path, input.target.symbolPath),
  );
  if (matches.length === 0) {
    return invariantResult(input.invariant, 'NO_VERDICT', 'target_not_resolved',
      `Invariant target "${input.target.symbolPath.join('.')}" was not resolved.`,
      null);
  }
  if (matches.length > 1) {
    return invariantResult(input.invariant, 'DEGRADED', 'target_ambiguous',
      `Invariant target "${input.target.symbolPath.join('.')}" matched ${matches.length} nodes.`,
      null);
  }
  const match = matches[0]!;
  const provenance = makeProvenance(parsed, match.path, match.node);
  if (!targetIdentityMatches(input.target, provenance)) {
    return invariantResult(input.invariant, 'NO_VERDICT', 'target_identity_stale',
      'Invariant target identity is stale or no longer matches the preview AST.',
      provenance);
  }
  return { node: match.node, provenance };
}

export async function parsePreviewFile(input: {
  readonly file: string;
  readonly invariant: DeclarativeInvariantBinding;
  readonly files: ReadonlyMap<string, MaterializedDryRunChange>;
  readonly parsedFiles: Map<string, ParsedPreviewFile | InvariantCheckResult>;
  readonly codeIntelligence: CodeIntelligenceAdapter;
  readonly signal?: AbortSignal | undefined;
}): Promise<ParsedPreviewFile | InvariantCheckResult> {
  const cached = input.parsedFiles.get(input.file);
  if (cached) return cached;
  const change = input.files.get(input.file);
  if (change === undefined) {
    const noVerdict = invariantResult(input.invariant, 'NO_VERDICT', 'target_not_in_preview',
      `Invariant target file "${input.file}" is not present in the dry-run preview.`,
      null);
    input.parsedFiles.set(input.file, noVerdict);
    return noVerdict;
  }
  const bytes = new TextEncoder().encode(change.content);
  try {
    const parsed = {
      path: input.file,
      bytes,
      tree: await input.codeIntelligence.parse(input.file, bytes, input.signal),
    };
    input.parsedFiles.set(input.file, parsed);
    return parsed;
  } catch (err) {
    const parseFailure = invariantResult(input.invariant, 'DEGRADED', 'parse_failed',
      `Invariant target file "${input.file}" could not be parsed: ${parseDetail(err)}.`,
      null);
    input.parsedFiles.set(input.file, parseFailure);
    return parseFailure;
  }
}

export function findExportedNode(
  tree: SyntaxTree,
  symbolName: string,
): RefinedNode | null {
  const root = tree.rootNode as unknown as RefinedNode;
  const children = root.namedChildren ?? [];
  for (const child of children) {
    if (child.kind !== 'export_statement') continue;
    const declared = findFirstDeclaration(child);
    if (declared && extractDeclaredName(declared) === symbolName) return declared;
  }
  return null;
}

export function makeProvenance(
  parsed: ParsedPreviewFile,
  symbolPath: readonly string[],
  node: RefinedNode,
): InvariantNodeProvenance {
  const byteRange = node.byteRange ?? [0, 0];
  const nodeBytes = parsed.bytes.subarray(byteRange[0], byteRange[1]);
  return {
    file: parsed.path,
    symbolPath: [...symbolPath],
    nodeKind: node.kind,
    byteRange,
    sourceHash: `sha256:${createHash('sha256').update(nodeBytes).digest('hex')}`,
    provenanceKind: 'tree_sitter_ast_node',
  };
}

export function hasField(node: RefinedNode, fieldName: string): boolean {
  if (
    (node.kind === 'property_identifier' ||
      node.kind === 'identifier' ||
      node.kind === 'field_identifier') &&
    node.text === fieldName
  ) {
    return true;
  }
  return (node.namedChildren ?? []).some((child) => hasField(child, fieldName));
}

export function isFunctionLike(kind: string): boolean {
  return kind.includes('function') || kind.includes('method');
}

export function isAsyncNode(node: RefinedNode): boolean {
  return /\basync\b/.test(node.text ?? '');
}

export function hasReturnAnnotation(node: RefinedNode, annotation: string): boolean {
  return (node.text ?? '').includes(`: ${annotation}`);
}

function collectDeclarationNodes(
  tree: SyntaxTree,
): { path: string[]; node: RefinedNode }[] {
  const out: { path: string[]; node: RefinedNode }[] = [];
  collectDeclarations(tree.rootNode as unknown as RefinedNode, [], out);
  return out;
}

function collectDeclarations(
  node: RefinedNode,
  ancestors: readonly string[],
  out: { path: string[]; node: RefinedNode }[],
): void {
  for (const child of node.namedChildren ?? []) {
    const name = extractDeclaredName(child);
    if (name !== null && child.kind !== 'export_statement') {
      const path = [...ancestors, name];
      out.push({ path, node: child });
      collectDeclarations(child, path, out);
      continue;
    }
    collectDeclarations(child, ancestors, out);
  }
}

function findFirstDeclaration(node: RefinedNode): RefinedNode | null {
  if (extractDeclaredName(node) !== null && node.kind !== 'export_statement') return node;
  for (const child of node.namedChildren ?? []) {
    const found = findFirstDeclaration(child);
    if (found !== null) return found;
  }
  return null;
}

function extractDeclaredName(node: RefinedNode): string | null {
  if (node.kind === 'export_statement') return null;
  for (const child of node.namedChildren ?? []) {
    if (
      child.kind === 'identifier' ||
      child.kind === 'type_identifier' ||
      child.kind === 'property_identifier'
    ) {
      return child.text ?? null;
    }
  }
  return null;
}

function targetIdentityMatches(
  target: InvariantAstTarget,
  provenance: InvariantNodeProvenance,
): boolean {
  if (target.nodeKind !== undefined && target.nodeKind !== provenance.nodeKind) return false;
  if (target.sourceHash !== undefined && target.sourceHash !== provenance.sourceHash) return false;
  if (target.byteRange !== undefined && !rangesEqual(target.byteRange, provenance.byteRange)) {
    return false;
  }
  return true;
}

function pathsEqual(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function rangesEqual(left: readonly [number, number], right: readonly [number, number]): boolean {
  return left[0] === right[0] && left[1] === right[1];
}

function parseDetail(err: unknown): string {
  if (err instanceof AdapterError) return err.kind;
  if (err instanceof Error) return err.message;
  return String(err);
}
