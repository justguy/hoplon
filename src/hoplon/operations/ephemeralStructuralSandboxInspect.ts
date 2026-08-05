import type {
  CodeIntelligenceAdapter,
  Symbol as CodeSymbol,
  SyntaxTree,
} from '../adapters/codeIntelligence.js';
import type {
  EphemeralStructuralSandboxResult,
  SandboxLanguage,
  StructuralSandboxExpectationFailure,
  StructuralSandboxSnippet,
  StructuralSandboxSnippetResult,
  StructuralSandboxStructureCheck,
} from '../contracts/structuralSandbox.js';

export interface StructuralSandboxEvalDeps {
  codeIntelligence: CodeIntelligenceAdapter;
  parseTimeoutMs: number;
}

interface StructuralNode {
  kind: string;
  children?: unknown[];
  namedChildren?: unknown[];
}

export async function evaluateStructuralSandboxSnippet(
  deps: StructuralSandboxEvalDeps,
  snippet: StructuralSandboxSnippet,
  signal: AbortSignal | undefined,
): Promise<StructuralSandboxSnippetResult> {
  const parsePath = parsePathFor(snippet);
  const parseSignal = buildParseSignal(signal, deps.parseTimeoutMs);
  let tree: SyntaxTree;
  try {
    tree = await deps.codeIntelligence.parse(
      parsePath,
      new TextEncoder().encode(snippet.content),
      parseSignal,
    );
  } catch (err) {
    if (isOperationAbort(err, signal)) throw err;
    return {
      id: snippet.id,
      path: snippet.path,
      status: 'PARSE_FAILED',
      parse: {
        status: 'FAILED',
        parser: 'codeIntelligence.parse',
        language: snippet.language ?? null,
        errorMessage: errorMessage(err),
      },
      structure: unavailableStructure(),
    };
  }

  const structure = inspectStructure(deps.codeIntelligence, tree, snippet);
  return {
    id: snippet.id,
    path: snippet.path,
    status:
      structure.status === 'OK'
        ? 'STRUCTURE_OK'
        : structure.status === 'ISSUES'
          ? 'STRUCTURE_ISSUES'
          : 'DEGRADED',
    parse: {
      status: 'OK',
      parser: 'codeIntelligence.parse',
      language: parsedLanguage(tree, snippet.language),
      errorMessage: null,
    },
    structure,
  };
}

export function summarizeStructuralSandboxStatus(
  snippets: readonly StructuralSandboxSnippetResult[],
): EphemeralStructuralSandboxResult['status'] {
  if (snippets.some((snippet) => snippet.status === 'DEGRADED')) return 'DEGRADED';
  if (snippets.some((snippet) => snippet.status !== 'STRUCTURE_OK')) {
    return 'PARSE_OR_STRUCTURE_ISSUES';
  }
  return 'PARSE_AND_STRUCTURE_OK';
}

export function structuralSandboxTypeProviderCheck(
  requested: boolean,
): EphemeralStructuralSandboxResult['typeProvider'] {
  if (!requested) {
    return {
      status: 'NOT_REQUESTED',
      providerId: null,
      reason: null,
      compilerProof: false,
    };
  }
  return {
    status: 'UNAVAILABLE',
    providerId: null,
    reason: 'no_in_memory_type_provider',
    compilerProof: false,
  };
}

function inspectStructure(
  codeIntelligence: CodeIntelligenceAdapter,
  tree: SyntaxTree,
  snippet: StructuralSandboxSnippet,
): StructuralSandboxStructureCheck {
  const root = asNode(tree.rootNode);
  if (root === null) return unavailableStructure();

  let symbols: CodeSymbol[];
  try {
    symbols = codeIntelligence.getTopLevelSymbols(tree);
  } catch {
    return unavailableStructure();
  }

  const nodeKindCounts: Record<string, number> = {};
  countNodeKinds(root, nodeKindCounts);
  const expectationFailures = expectationFailuresFor(snippet, root, nodeKindCounts, symbols);
  const errorNodeCount = structuralErrorCount(nodeKindCounts);
  const status =
    errorNodeCount === 0 && expectationFailures.length === 0 ? 'OK' : 'ISSUES';

  return {
    status,
    rootKind: root.kind,
    nodeKindCounts,
    errorNodeCount,
    topLevelSymbols: symbols.map((symbol) => ({
      name: symbol.name,
      kind: symbol.kind,
      byteRange: symbol.byteRange,
    })),
    expectationFailures,
  };
}

function expectationFailuresFor(
  snippet: StructuralSandboxSnippet,
  root: StructuralNode,
  nodeKindCounts: Record<string, number>,
  symbols: CodeSymbol[],
): StructuralSandboxExpectationFailure[] {
  const expectations = snippet.expectations;
  if (expectations === undefined) return [];
  const failures: StructuralSandboxExpectationFailure[] = [];

  if (expectations.rootKind !== undefined && expectations.rootKind !== root.kind) {
    failures.push({
      kind: 'root_kind_mismatch',
      expected: expectations.rootKind,
      actual: root.kind,
      message: `Expected root kind ${expectations.rootKind}; parsed ${root.kind}.`,
    });
  }

  for (const kind of expectations.requiredNodeKinds ?? []) {
    if ((nodeKindCounts[kind] ?? 0) === 0) {
      failures.push({
        kind: 'missing_node_kind',
        expected: kind,
        actual: null,
        message: `Expected at least one ${kind} node.`,
      });
    }
  }

  const symbolNames = new Set(symbols.map((symbol) => symbol.name));
  for (const name of expectations.requiredTopLevelSymbols ?? []) {
    if (!symbolNames.has(name)) {
      failures.push({
        kind: 'missing_top_level_symbol',
        expected: name,
        actual: null,
        message: `Expected top-level symbol ${name}.`,
      });
    }
  }

  return failures;
}

function parsePathFor(snippet: StructuralSandboxSnippet): string {
  if (snippet.language === undefined) return snippet.path;
  return `${snippet.path}${extensionFor(snippet.language)}`;
}

function extensionFor(language: SandboxLanguage): string {
  if (language === 'javascript') return '.js';
  if (language === 'typescript') return '.ts';
  return '.tsx';
}

function parsedLanguage(
  tree: SyntaxTree,
  fallback: SandboxLanguage | undefined,
): SandboxLanguage | null {
  const language = (tree as { language?: unknown }).language;
  if (
    language === 'javascript' ||
    language === 'typescript' ||
    language === 'tsx'
  ) {
    return language;
  }
  return fallback ?? null;
}

function countNodeKinds(node: StructuralNode, counts: Record<string, number>): void {
  counts[node.kind] = (counts[node.kind] ?? 0) + 1;
  for (const child of childNodes(node)) countNodeKinds(child, counts);
}

function childNodes(node: StructuralNode): StructuralNode[] {
  const raw = Array.isArray(node.children) ? node.children : [];
  return raw.map(asNode).filter((child): child is StructuralNode => child !== null);
}

function structuralErrorCount(counts: Record<string, number>): number {
  let total = 0;
  for (const [kind, count] of Object.entries(counts)) {
    if (kind === 'ERROR' || kind === 'MISSING' || kind.startsWith('ERROR')) {
      total += count;
    }
  }
  return total;
}

function asNode(value: unknown): StructuralNode | null {
  if (typeof value !== 'object' || value === null) return null;
  const kind = (value as { kind?: unknown }).kind;
  if (typeof kind !== 'string' || kind.length === 0) return null;
  const node = value as { children?: unknown; namedChildren?: unknown };
  return {
    kind,
    children: Array.isArray(node.children) ? node.children : [],
    namedChildren: Array.isArray(node.namedChildren) ? node.namedChildren : [],
  };
}

function unavailableStructure(): StructuralSandboxStructureCheck {
  return {
    status: 'UNAVAILABLE',
    rootKind: null,
    nodeKindCounts: {},
    errorNodeCount: 0,
    topLevelSymbols: [],
    expectationFailures: [],
  };
}

function buildParseSignal(
  opSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (opSignal === undefined) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([opSignal, timeoutSignal]);
  }
  const controller = new AbortController();
  const abort = (source: AbortSignal): void => {
    if (!controller.signal.aborted) controller.abort(source.reason);
  };
  opSignal.addEventListener('abort', () => { abort(opSignal); }, { once: true });
  timeoutSignal.addEventListener('abort', () => { abort(timeoutSignal); }, { once: true });
  return controller.signal;
}

function isOperationAbort(err: unknown, signal: AbortSignal | undefined): boolean {
  return signal?.aborted === true && err instanceof Error && err.name === 'AbortError';
}

function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
