/**
 * operations/searchSymbols.ts — t-056 local AST-aware structural search.
 *
 * Reuses the standard tree-sitter query bundle (function declarations, class
 * declarations, top-level interface/type/enum aliases, class methods, and
 * exported declarations) and filters captured identifier names against a
 * caller-supplied regex.
 *
 * ## What this is — and what this is not
 *   - This finds *declared* symbols. It is the right tool for "where is the
 *     function `createFoo`?" or "which classes match `^Service$`?".
 *   - It is NOT a replacement for raw text grep over docs, logs, comments,
 *     env vars, JSON config, or arbitrary string literals — those are not
 *     symbol declarations, and shoehorning them in here would dilute the
 *     structural-truth posture this slice exists to preserve.
 *
 * ## Determinism (H7)
 *   Files iterated alphabetically; matches sorted by `(path, name, byteRange[0])`.
 *
 * ## Path safety (H9)
 *   Every explicit and discovered path is canonicalized via canonicalizePath.
 *
 * ## H13 compliance
 *   Emitted events carry counts and operation phase only; no symbol names,
 *   no source slices, no captured text reaches HoplonEvent.
 *
 * ## H15 compliance
 *   `maxFileBytes` and `parseTimeoutMs` are honored via queryStructure;
 *   bad files surface in `failures`. `maxResults` caps the response size.
 *
 * ## Import wall
 *   Only ../adapters/*, ../contracts/*, ../util/*, sibling ops.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import {
  SearchSymbolsRequestSchema,
  type SearchSymbolMatch,
  type SearchSymbolsRequest,
  type SearchSymbolsResult,
  type SearchableSymbolKind,
} from '../contracts/searchSymbols.js';
import type { QueryMatch, TreeSitterQuery } from '../contracts/queryStructure.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { queryStructure } from './queryStructure.js';
import type { QueryStructureDeps } from './queryStructure.js';
import {
  STD_QUERY_FUNCTION_SIGNATURES,
  STD_QUERY_EXPORTS,
  STD_QUERY_CLASS_METHODS,
} from './stdQueries.js';
import {
  CLASS_DECL_QUERIES,
  ENUM_QUERIES,
  INTERFACE_QUERIES,
  KIND_TO_QUERY_IDS,
  TYPE_ALIAS_QUERIES,
  queryIdToKind,
} from './searchSymbolsQueries.js';
import { collectFiles } from './getRelevantTestsInternal.js';

export interface SearchSymbolsDeps {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: { maxFileBytes: number; parseTimeoutMs: number };
}

const ALL_KINDS: readonly SearchableSymbolKind[] = [
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'method',
  'export',
];

export async function searchSymbols(
  deps: SearchSymbolsDeps,
  req: SearchSymbolsRequest,
  signal?: AbortSignal,
): Promise<SearchSymbolsResult> {
  const { fs, codeIntelligence, emitter, engineId, root, config } = deps;
  const startMs = Date.now();

  const parseResult = SearchSymbolsRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const corrId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string' &&
      ((req as { correlationId?: string }).correlationId ?? '').length > 0
        ? (req as { correlationId: string }).correlationId
        : 'validator';
    throw new ValidationError(
      { kind: 'invalid_manifest', engineId, correlationId: corrId, cause: parseResult.error },
      `searchSymbols: invalid request: ${parseResult.error.message}`,
    );
  }
  const validated = parseResult.data;

  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);

  let nameRe: RegExp;
  try {
    nameRe = new RegExp(validated.namePattern);
  } catch (err) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId: validated.correlationId,
        cause: err,
      },
      `searchSymbols: namePattern is not a valid JavaScript regex: ${
        err instanceof Error ? err.message : String(err)
      }`,
    );
  }

  const targetFiles = validated.files ?? (await collectFiles(fs, '.'));
  for (const p of targetFiles) {
    canonicalizePath({ path: p, root, engineId, correlationId: validated.correlationId });
  }
  const sortedFiles = [...targetFiles].sort();

  emitter.emit({
    op: 'searchSymbols',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  const enabledKinds = new Set<SearchableSymbolKind>(validated.kinds ?? ALL_KINDS);
  const enabledQueryIds = new Set<string>();
  for (const k of enabledKinds) {
    for (const id of KIND_TO_QUERY_IDS[k]) enabledQueryIds.add(id);
  }

  const qsDeps: QueryStructureDeps = {
    fs,
    codeIntelligence,
    emitter,
    engineId,
    root,
    config,
  };

  let result: SearchSymbolsResult;
  try {
    if (sortedFiles.length === 0) {
      result = { matches: [], failures: [], filesScanned: 0, truncated: false };
    } else {
      const queries: TreeSitterQuery[] = buildQueryBundle(enabledKinds);
      const qsResult = await queryStructure(
        qsDeps,
        {
          projectId: validated.projectId,
          runId: validated.runId,
          correlationId: validated.correlationId,
          files: sortedFiles,
          queries,
        },
        signal,
      );
      const matches = projectMatches(qsResult.matches, enabledQueryIds, nameRe);
      const truncated = matches.length > validated.maxResults;
      result = {
        matches: truncated ? matches.slice(0, validated.maxResults) : matches,
        failures: uniqueFailures(qsResult.failures),
        filesScanned: sortedFiles.length,
        truncated,
      };
    }
  } catch (err) {
    emitter.emit({
      op: 'searchSymbols',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
    });
    throw err;
  }

  emitter.emit({
    op: 'searchSymbols',
    phase: 'end',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs: Date.now() - startMs,
    classification: 'PASS',
  });

  return result;
}

function buildQueryBundle(enabled: Set<SearchableSymbolKind>): TreeSitterQuery[] {
  const queries: TreeSitterQuery[] = [];
  if (enabled.has('function')) queries.push(...STD_QUERY_FUNCTION_SIGNATURES);
  if (enabled.has('class')) queries.push(...CLASS_DECL_QUERIES);
  if (enabled.has('interface')) queries.push(...INTERFACE_QUERIES);
  if (enabled.has('type')) queries.push(...TYPE_ALIAS_QUERIES);
  if (enabled.has('enum')) queries.push(...ENUM_QUERIES);
  if (enabled.has('method')) queries.push(...STD_QUERY_CLASS_METHODS);
  if (enabled.has('export')) queries.push(...STD_QUERY_EXPORTS);
  return queries;
}

function projectMatches(
  raw: readonly QueryMatch[],
  enabledQueryIds: Set<string>,
  nameRe: RegExp,
): SearchSymbolMatch[] {
  const out: SearchSymbolMatch[] = [];
  for (const m of raw) {
    if (!enabledQueryIds.has(m.queryId)) continue;
    const name = extractName(m);
    if (name === undefined || !nameRe.test(name)) continue;
    out.push({
      path: m.path,
      name,
      kind: queryIdToKind(m.queryId),
      byteRange: [m.byteRange[0], m.byteRange[1]],
      nodeKind: m.nodeKind,
    });
  }
  out.sort((a, b) => {
    if (a.path < b.path) return -1;
    if (a.path > b.path) return 1;
    if (a.name < b.name) return -1;
    if (a.name > b.name) return 1;
    return a.byteRange[0] - b.byteRange[0];
  });
  return out;
}

function extractName(match: QueryMatch): string | undefined {
  if (match.queryId === 'extract-exports') {
    return firstNonKeywordIdentifier(match.text);
  }
  const text = match.text.trim();
  return text.length > 0 ? text : undefined;
}

// Tokens that lead a JS/TS declaration but are not the symbol name itself.
const DECL_KEYWORDS = new Set([
  'function',
  'class',
  'interface',
  'type',
  'enum',
  'const',
  'let',
  'var',
  'async',
  'abstract',
  'declare',
  'default',
  'export',
  'public',
  'private',
  'protected',
  'readonly',
  'static',
]);

function firstNonKeywordIdentifier(text: string): string | undefined {
  const re = /[A-Za-z_$][A-Za-z0-9_$]*/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    if (!DECL_KEYWORDS.has(m[0])) return m[0];
  }
  return undefined;
}

function uniqueFailures(
  failures: SearchSymbolsResult['failures'],
): SearchSymbolsResult['failures'] {
  return [...new Map(failures.map((f) => [`${f.path}\u0000${f.reason}\u0000${f.message}`, f])).values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.message.localeCompare(b.message)));
}
