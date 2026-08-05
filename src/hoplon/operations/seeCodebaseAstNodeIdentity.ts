import { createHash } from 'node:crypto';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import type { SeeCodebaseAstNodeIdentity } from '../contracts/seeCodebase.js';
import type { StructuralTargetMatch } from '../util/structuralTargetTree.js';
import type { AstNodeTarget } from './seeCodebaseAstNode.js';
import { SeeCodebaseAstNodeError } from './seeCodebaseAstNodeErrors.js';

export function buildAstNodeIdentity(
  path: string,
  match: StructuralTargetMatch,
  tree: RefinedSyntaxTree,
  contentBytes: Uint8Array,
): SeeCodebaseAstNodeIdentity {
  const contentSha256 = sha256Bytes(contentBytes);
  const base = {
    path,
    symbolPath: [...match.path],
    name: match.name,
    kind: match.kind,
    nodeKind: match.kind,
    byteRange: match.byteRange,
    contentSha256,
    grammarVersion: tree.grammarVersion,
    language: tree.language,
  };
  return {
    stableId: `ast-node:v1:${sha256Text(JSON.stringify(base))}`,
    ...base,
  };
}

export function assertExpectedAstNodeIdentity(
  target: AstNodeTarget,
  identity: SeeCodebaseAstNodeIdentity,
): void {
  const expected = target.expectedIdentity;
  if (expected === undefined) return;
  const stale =
    (expected.stableId !== undefined && expected.stableId !== identity.stableId) ||
    (expected.nodeKind !== undefined && expected.nodeKind !== identity.nodeKind) ||
    (expected.contentSha256 !== undefined &&
      expected.contentSha256 !== identity.contentSha256) ||
    (expected.grammarVersion !== undefined &&
      expected.grammarVersion !== identity.grammarVersion) ||
    (expected.byteRange !== undefined &&
      (expected.byteRange[0] !== identity.byteRange[0] ||
        expected.byteRange[1] !== identity.byteRange[1]));
  if (stale) {
    throw new SeeCodebaseAstNodeError(
      'STALE_TARGET',
      `AST node target identity is stale: ${targetKey(target)}`,
    );
  }
}

function targetKey(target: AstNodeTarget): string {
  const selector =
    target.selector.kind === 'symbol'
      ? target.selector.name
      : target.selector.symbolPath.join('.');
  return `${target.file}#${target.selector.kind}:${selector}`;
}

function sha256Bytes(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}
