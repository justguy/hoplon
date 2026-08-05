import type { CodeIntelligenceAdapter, Symbol } from '../adapters/codeIntelligence.js';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import type {
  SeeCodebasePrimitiveId,
  SeeCodebaseRequestValidated,
  SeeCodebaseResult,
  SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import {
  resolveSymbolPathMatches,
  type StructuralTargetMatch,
} from '../util/structuralTargetTree.js';
import type { SeeCodebaseDeps } from './seeCodebase.js';
import {
  assertStrictPathClass,
  assertStrictPathWithinFolder,
  assertStrictReadableBytes,
  isJsTsPath,
} from './seeCodebaseFilePolicy.js';
import {
  SeeCodebaseAstNodeError,
  isSeeCodebaseAstNodeError,
} from './seeCodebaseAstNodeErrors.js';
import {
  assertExpectedAstNodeIdentity,
  buildAstNodeIdentity,
} from './seeCodebaseAstNodeIdentity.js';
import { liveFsProvenance } from './seeCodebaseProvenance.js';

export type AstNodeTarget = Extract<SeeCodebaseTarget, { kind: 'ast_node' }>;

export async function executeAstNodeTargets(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  targets: readonly SeeCodebaseTarget[],
  signal: AbortSignal | undefined,
  results: SeeCodebaseResult[],
  used: Set<SeeCodebasePrimitiveId>,
): Promise<void> {
  const nodeTargets = targets.filter(isAstNodeTarget);
  const seen = new Set<string>();
  for (const target of nodeTargets) {
    const key = targetKey(target);
    if (seen.has(key)) {
      throw new SeeCodebaseAstNodeError(
        'DUPLICATE_TARGET',
        `duplicate AST node target: ${key}`,
      );
    }
    seen.add(key);
  }
  for (const target of nodeTargets) {
    results.push(await readAstNodeTarget(deps, request, target, signal));
    used.add('readAstNode');
  }
}

async function readAstNodeTarget(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  target: AstNodeTarget,
  signal: AbortSignal | undefined,
): Promise<SeeCodebaseResult> {
  validateTargetPath(deps, request, target);
  const stat = await deps.fs.stat(target.file);
  if (!stat.exists) {
    throw new SeeCodebaseAstNodeError(
      'PATH_NOT_FOUND',
      `AST node target file not found: ${target.file}`,
    );
  }
  if (!stat.isFile || stat.size > deps.config.maxFileBytes) {
    throw new SeeCodebaseAstNodeError(
      'UNSUPPORTED_TARGET',
      `AST node target file is not readable as a supported JS/TS source: ${target.file}`,
    );
  }

  const bytes = await deps.fs.read(target.file);
  if (request.engagement !== undefined) assertStrictReadableBytes(target.file, bytes);
  const codeIntelligence = requireCodeIntelligence(deps);
  const tree = await parseTree(codeIntelligence, target, bytes, deps.config.parseTimeoutMs, signal);
  const match = resolveTargetMatch(codeIntelligence, tree, target);
  const contentBytes = bytes.subarray(match.byteRange[0], match.byteRange[1]);
  const content = new TextDecoder('utf-8').decode(contentBytes);
  const identity = buildAstNodeIdentity(target.file, match, tree, contentBytes);
  assertExpectedAstNodeIdentity(target, identity);

  return {
    kind: 'ast_node',
    path: target.file,
    content,
    identity,
    readProvenance: liveFsProvenance(deps.root, target.file),
  };
}

function validateTargetPath(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  target: AstNodeTarget,
): void {
  canonicalizePath({
    path: target.file,
    root: deps.root,
    engineId: deps.engineId,
    correlationId: request.correlationId,
  });
  if (!isJsTsPath(target.file) || isGeneratedAstNodePath(target.file)) {
    throw new SeeCodebaseAstNodeError(
      'UNSUPPORTED_TARGET',
      `AST node reads support non-generated JS/TS files only: ${target.file}`,
    );
  }
  if (request.engagement !== undefined) {
    try {
      assertStrictPathWithinFolder(target.file, request.engagement.folder);
      assertStrictPathClass(target.file);
    } catch (err) {
      throw new SeeCodebaseAstNodeError(
        'OUT_OF_SCOPE_TARGET',
        err instanceof Error ? err.message : String(err),
      );
    }
  }
}

function requireCodeIntelligence(deps: SeeCodebaseDeps): CodeIntelligenceAdapter {
  if (deps.codeIntelligence === undefined) {
    throw new SeeCodebaseAstNodeError(
      'UNSUPPORTED_TARGET',
      'AST node reads require a Tree-sitter code intelligence adapter',
    );
  }
  return deps.codeIntelligence;
}

async function parseTree(
  codeIntelligence: CodeIntelligenceAdapter,
  target: AstNodeTarget,
  bytes: Uint8Array,
  parseTimeoutMs: number,
  signal: AbortSignal | undefined,
): Promise<RefinedSyntaxTree> {
  try {
    const tree = await codeIntelligence.parse(
      target.file,
      bytes,
      buildParseSignal(signal, parseTimeoutMs),
    );
    const refined = tree as Partial<RefinedSyntaxTree>;
    if (
      refined.language === undefined ||
      refined.grammarVersion === undefined
    ) {
      throw new SeeCodebaseAstNodeError(
        'UNSUPPORTED_TARGET',
        'AST node reads require Tree-sitter language and grammar provenance',
      );
    }
    return refined as RefinedSyntaxTree;
  } catch (err) {
    if (isAbortError(err) || isSeeCodebaseAstNodeError(err)) throw err;
    throw new SeeCodebaseAstNodeError(
      'UNSUPPORTED_TARGET',
      `AST node target could not be parsed: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
}

function resolveTargetMatch(
  codeIntelligence: CodeIntelligenceAdapter,
  tree: RefinedSyntaxTree,
  target: AstNodeTarget,
): StructuralTargetMatch {
  const matches =
    target.selector.kind === 'symbol'
      ? topLevelSymbolMatches(codeIntelligence, tree, target.selector.name)
      : resolveSymbolPathMatches(tree, target.selector.symbolPath);
  if (matches.length === 0) {
    throw new SeeCodebaseAstNodeError(
      'UNRESOLVED_TARGET',
      `AST node target did not resolve: ${targetKey(target)}`,
    );
  }
  if (matches.length > 1) {
    throw new SeeCodebaseAstNodeError(
      'AMBIGUOUS_TARGET',
      `AST node target matched ${matches.length} nodes: ${targetKey(target)}`,
    );
  }
  return matches[0]!;
}

function topLevelSymbolMatches(
  codeIntelligence: CodeIntelligenceAdapter,
  tree: RefinedSyntaxTree,
  name: string,
): StructuralTargetMatch[] {
  return codeIntelligence.getTopLevelSymbols(tree)
    .filter((symbol) => symbol.name === name)
    .map(symbolToStructuralMatch);
}

function symbolToStructuralMatch(symbol: Symbol): StructuralTargetMatch {
  return { ...symbol, path: [symbol.name] };
}

function isAstNodeTarget(target: SeeCodebaseTarget): target is AstNodeTarget {
  return target.kind === 'ast_node';
}

function targetKey(target: AstNodeTarget): string {
  const selector =
    target.selector.kind === 'symbol'
      ? target.selector.name
      : target.selector.symbolPath.join('.');
  return `${target.file}#${target.selector.kind}:${selector}`;
}

function isGeneratedAstNodePath(path: string): boolean {
  const normalized = path.replace(/\\/gu, '/').toLowerCase();
  const parts = normalized.split('/').filter((part) => part.length > 0);
  const basename = parts.at(-1) ?? normalized;
  return (
    parts.includes('generated') ||
    parts.includes('__generated__') ||
    basename.includes('.generated.') ||
    basename.includes('.gen.')
  );
}

function buildParseSignal(
  signal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (signal === undefined) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([signal, timeoutSignal]);
  }
  const controller = new AbortController();
  if (signal.aborted) { controller.abort(signal.reason); return controller.signal; }
  if (timeoutSignal.aborted) { controller.abort(timeoutSignal.reason); return controller.signal; }
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
    signal.removeEventListener('abort', onSignalAbort);
    timeoutSignal.removeEventListener('abort', onTimeoutAbort);
  };
  const onSignalAbort = (): void => { abort(signal.reason); };
  const onTimeoutAbort = (): void => { abort(timeoutSignal.reason); };
  signal.addEventListener('abort', onSignalAbort, { once: true });
  timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });
  return controller.signal;
}

function isAbortError(err: unknown): boolean {
  return (
    (err instanceof DOMException && err.name === 'AbortError') ||
    (err instanceof Error && err.name === 'AbortError')
  );
}
