/** t-120 read-only syntax-node lookup over Tree-sitter backed parses. */

import type { Node as TSNode, Point } from 'web-tree-sitter';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import {
  charPosToBytePos,
  detectLanguage,
} from '../adapters/codeIntelligence/treeSitter.js';
import {
  FindSyntaxNodeRequestSchema,
  FindSyntaxNodeResultSchema,
  type FindSyntaxNodeRequest,
  type FindSyntaxNodeResult,
  type SyntaxHealthNode,
  type SyntaxHealthSidecar,
  type SyntaxNodeSummary,
} from '../contracts/syntaxNodeLookup.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';

export interface FindSyntaxNodeDeps {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: { maxFileBytes: number; parseTimeoutMs: number };
}

export async function findSyntaxNode(
  deps: FindSyntaxNodeDeps,
  req: FindSyntaxNodeRequest,
  signal?: AbortSignal,
): Promise<FindSyntaxNodeResult> {
  const parsed = FindSyntaxNodeRequestSchema.safeParse(req);
  if (!parsed.success) {
    throw new ValidationError(
      { kind: 'invalid_manifest', engineId: deps.engineId, correlationId: readCorr(req), cause: parsed.error },
      `findSyntaxNode: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);
  validateRunId(request.runId);
  canonicalizePath({ path: request.file, root: deps.root, engineId: deps.engineId, correlationId: request.correlationId });

  const start = Date.now();
  deps.emitter.emit({
    op: 'findSyntaxNode',
    phase: 'start',
    engineId: deps.engineId,
    projectId: request.projectId,
    runId: request.runId,
    correlationId: request.correlationId,
  });
  try {
    const result = await resolveNode(deps, request, signal);
    const checked = FindSyntaxNodeResultSchema.safeParse(result);
    if (!checked.success) {
      throw new ValidationError(
        { kind: 'invalid_manifest', engineId: deps.engineId, correlationId: request.correlationId, cause: checked.error },
        `findSyntaxNode: produced invalid result: ${checked.error.message}`,
      );
    }
    deps.emitter.emit({
      op: 'findSyntaxNode',
      phase: 'end',
      engineId: deps.engineId,
      projectId: request.projectId,
      runId: request.runId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });
    return checked.data;
  } catch (err) {
    deps.emitter.emit({
      op: 'findSyntaxNode',
      phase: 'error',
      engineId: deps.engineId,
      projectId: request.projectId,
      runId: request.runId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}
async function resolveNode(
  deps: FindSyntaxNodeDeps,
  request: FindSyntaxNodeRequest,
  signal: AbortSignal | undefined,
): Promise<FindSyntaxNodeResult> {
  if (detectLanguage(request.file) === null) {
    return failure(request, 'UNSUPPORTED_FILE', unavailable('unsupported_extension'), 'unsupported_extension');
  }
  const stat = await deps.fs.stat(request.file);
  if (!stat.exists) return failure(request, 'FILE_NOT_FOUND', unavailable('file_not_found'), 'file_not_found');
  if (!stat.isFile || stat.size > deps.config.maxFileBytes) {
    return failure(request, 'FILE_TOO_LARGE', unavailable('file_too_large'), 'file_too_large');
  }
  const content = await deps.fs.read(request.file);
  if (signal?.aborted) throw abortError(signal);
  const sourceText = new TextDecoder('utf-8').decode(content);
  const parseSignal = buildParseSignal(signal, deps.config.parseTimeoutMs);
  let tree: RefinedSyntaxTree;
  try {
    tree = await deps.codeIntelligence.parse(request.file, content, parseSignal) as RefinedSyntaxTree;
  } catch {
    return failure(request, 'PARSE_FAILED', unavailable('parse_failed'), 'parse_failed');
  }
  const rawRoot = tree._rawRootNode;
  if (rawRoot === undefined) {
    return failure(request, 'PARSE_FAILED', unavailable('raw_tree_unavailable'), 'raw_tree_unavailable');
  }

  const parserStatus = buildHealth(tree, sourceText);
  const lookup = lookupNode(rawRoot, sourceText, request);
  if (lookup.node === null) {
    return failure(request, 'INVALID_TARGET', parserStatus, lookup.reason);
  }
  return {
    correlationId: request.correlationId,
    advisory: true,
    status: 'FOUND',
    file: request.file,
    node: summarizeNode(lookup.node, sourceText, request.includeText === true),
    ancestors: ancestorsOf(lookup.node, sourceText),
    parserStatus,
    failureReason: null,
  };
}
function lookupNode(
  root: TSNode,
  sourceText: string,
  request: FindSyntaxNodeRequest,
): { node: TSNode | null; reason: FindSyntaxNodeResult['failureReason'] } {
  const target = request.target;
  if (target.type === 'byte_offset') {
    if (target.byteOffset > Buffer.byteLength(sourceText, 'utf8')) {
      return { node: null, reason: 'byte_offset_out_of_bounds' };
    }
    const charOffset = byteToCharPosition(sourceText, target.byteOffset);
    if (charOffset === null) return { node: null, reason: 'invalid_utf8_byte_boundary' };
    const node = target.namedOnly === true
      ? root.namedDescendantForIndex(charOffset)
      : root.descendantForIndex(charOffset);
    return { node, reason: node === null ? 'byte_offset_out_of_bounds' : null };
  }
  if (target.type === 'byte_range') {
    const [start, end] = target.byteRange;
    if (end > Buffer.byteLength(sourceText, 'utf8')) return { node: null, reason: 'byte_range_out_of_bounds' };
    const startChar = byteToCharPosition(sourceText, start);
    const endChar = byteToCharPosition(sourceText, end);
    if (startChar === null || endChar === null) return { node: null, reason: 'invalid_utf8_byte_boundary' };
    const node = target.namedOnly === true
      ? root.namedDescendantForIndex(startChar, endChar)
      : root.descendantForIndex(startChar, endChar);
    return { node, reason: node === null ? 'byte_range_out_of_bounds' : null };
  }
  const point = utf8PointToTreeSitterPoint(sourceText, target.position);
  const endPoint = target.endPosition ? utf8PointToTreeSitterPoint(sourceText, target.endPosition) : undefined;
  if (point === null || endPoint === null) return { node: null, reason: 'position_out_of_bounds' };
  const node = target.namedOnly === true
    ? root.namedDescendantForPosition(point, endPoint ?? undefined)
    : root.descendantForPosition(point, endPoint ?? undefined);
  return { node, reason: node === null ? 'position_out_of_bounds' : null };
}
function summarizeNode(node: TSNode, sourceText: string, includeText: boolean): SyntaxNodeSummary {
  const summary: SyntaxNodeSummary = {
    kind: node.type,
    byteRange: [charPosToBytePos(sourceText, node.startIndex), charPosToBytePos(sourceText, node.endIndex)],
    startPosition: node.startPosition,
    endPosition: node.endPosition,
    named: node.isNamed,
    missing: node.isMissing,
    error: node.isError,
  };
  if (includeText) summary.text = node.text;
  return summary;
}
function buildHealth(tree: RefinedSyntaxTree, sourceText: string): SyntaxHealthSidecar {
  const errorNodes: SyntaxHealthNode[] = [];
  const missingNodes: SyntaxHealthNode[] = [];
  collectHealth(tree._rawRootNode!, sourceText, errorNodes, missingNodes);
  return {
    advisory: true,
    status: errorNodes.length > 0 || missingNodes.length > 0 ? 'SYNTAX_RECOVERED' : 'OK',
    language: tree.language,
    grammarVersion: tree.grammarVersion,
    hasError: errorNodes.length > 0 || missingNodes.length > 0,
    errorNodes,
    missingNodes,
    degradationReason: null,
  };
}
function collectHealth(
  node: TSNode,
  sourceText: string,
  errorNodes: SyntaxHealthNode[],
  missingNodes: SyntaxHealthNode[],
): void {
  if (node.isError || node.type === 'ERROR') errorNodes.push(healthNode(node, sourceText));
  if (node.isMissing) missingNodes.push(healthNode(node, sourceText));
  for (const child of node.children) {
    if (child) collectHealth(child, sourceText, errorNodes, missingNodes);
  }
}

function healthNode(node: TSNode, sourceText: string): SyntaxHealthNode {
  return {
    kind: node.type,
    byteRange: [charPosToBytePos(sourceText, node.startIndex), charPosToBytePos(sourceText, node.endIndex)],
    missing: node.isMissing,
    error: node.isError || node.type === 'ERROR',
  };
}

function ancestorsOf(node: TSNode, sourceText: string): SyntaxNodeSummary[] {
  const ancestors: SyntaxNodeSummary[] = [];
  let cursor = node.parent;
  while (cursor !== null) {
    ancestors.push(summarizeNode(cursor, sourceText, false));
    cursor = cursor.parent;
  }
  return ancestors;
}

function unavailable(reason: NonNullable<SyntaxHealthSidecar['degradationReason']>): SyntaxHealthSidecar {
  return {
    advisory: true,
    status: 'UNAVAILABLE',
    language: null,
    grammarVersion: null,
    hasError: false,
    errorNodes: [],
    missingNodes: [],
    degradationReason: reason,
  };
}

function failure(
  request: FindSyntaxNodeRequest,
  status: Exclude<FindSyntaxNodeResult['status'], 'FOUND'>,
  parserStatus: SyntaxHealthSidecar,
  reason: FindSyntaxNodeResult['failureReason'],
): FindSyntaxNodeResult {
  return {
    correlationId: request.correlationId,
    advisory: true,
    status,
    file: request.file,
    node: null,
    ancestors: [],
    parserStatus,
    failureReason: reason,
  };
}

function byteToCharPosition(sourceText: string, byteOffset: number): number | null {
  let bytes = 0;
  let charIndex = 0;
  for (const char of sourceText) {
    if (bytes === byteOffset) return charIndex;
    bytes += Buffer.byteLength(char, 'utf8');
    charIndex += char.length;
  }
  return bytes === byteOffset ? charIndex : null;
}

function utf8PointToTreeSitterPoint(sourceText: string, point: Point): Point | null {
  const lines = sourceText.split('\n');
  const line = lines[point.row];
  if (line === undefined) return null;
  const column = byteToCharPosition(line, point.column);
  if (column === null) return null;
  return { row: point.row, column };
}

function buildParseSignal(opSignal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (opSignal === undefined) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') return AbortSignal.any([opSignal, timeoutSignal]);
  return opSignal;
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error ? signal.reason : new DOMException('Operation aborted', 'AbortError');
}

function readCorr(req: unknown): string {
  return typeof (req as { correlationId?: unknown })?.correlationId === 'string'
    ? (req as { correlationId: string }).correlationId
    : 'validator';
}
