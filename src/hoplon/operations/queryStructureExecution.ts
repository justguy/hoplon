import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import { detectLanguage } from '../adapters/codeIntelligence/treeSitter.js';
import type {
  QueryMatch,
  QueryMatchGroup,
  QueryStructureRequest,
  QueryStructureResult,
} from '../contracts/queryStructure.js';
import {
  runQuery,
  type CodeIntelligenceAdapterWithLanguages,
  type QueryFailure,
} from './queryStructureRunner.js';

interface ProcessQueryArgs {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  config: { maxFileBytes: number; parseTimeoutMs: number };
  validated: QueryStructureRequest;
  canonicalPaths: string[];
  signal: AbortSignal | undefined;
}

export async function processQuery(
  args: ProcessQueryArgs,
): Promise<QueryStructureResult> {
  const { fs, codeIntelligence, config, validated, canonicalPaths, signal } = args;
  const pairs = canonicalPaths.map((canonical, index) => ({
    canonical,
    relative: validated.files[index]!,
  }));
  pairs.sort((left, right) =>
    left.relative < right.relative
      ? -1
      : left.relative > right.relative
        ? 1
        : 0,
  );

  const matches: QueryMatch[] = [];
  const matchGroups: QueryMatchGroup[] = [];
  const failures: QueryFailure[] = [];
  const languages = (
    codeIntelligence as CodeIntelligenceAdapterWithLanguages
  )._languages;

  for (const { relative: relPath } of pairs) {
    if (signal?.aborted) throw abortError(signal);

    const stat = await fs.stat(relPath);
    if (!stat.exists) {
      addFailureForEveryQuery(
        failures,
        validated,
        relPath,
        'file_not_found',
        `File not found: ${relPath}`,
      );
      continue;
    }
    if (stat.size > config.maxFileBytes) {
      addFailureForEveryQuery(
        failures,
        validated,
        relPath,
        'parse_failure',
        `File too large: ${stat.size} bytes (limit: ${config.maxFileBytes})`,
      );
      continue;
    }

    let content: Uint8Array;
    try {
      content = await fs.read(relPath);
    } catch (error) {
      addFailureForEveryQuery(
        failures,
        validated,
        relPath,
        'parse_failure',
        `Failed to read file: ${errorMessage(error)}`,
      );
      continue;
    }
    if (signal?.aborted) throw abortError(signal);

    const detectedLanguage = detectLanguage(relPath);
    for (const treeSitterQuery of validated.queries) {
      if (detectedLanguage !== treeSitterQuery.language) continue;

      let tree: RefinedSyntaxTree;
      try {
        tree = (await codeIntelligence.parse(
          relPath,
          content,
          buildParseSignal(signal, config.parseTimeoutMs),
        )) as RefinedSyntaxTree;
      } catch (error) {
        if (isAbortError(error) && !isTimeoutError(error)) throw error;
        failures.push({
          path: relPath,
          queryId: treeSitterQuery.id,
          reason: 'parse_failure',
          message: `Parse failed: ${errorMessage(error)}`,
        });
        continue;
      }

      const records = runQuery(
        relPath,
        treeSitterQuery,
        tree,
        new TextDecoder('utf-8').decode(content),
        languages,
        failures,
      );
      matches.push(...records.matches);
      matchGroups.push(...records.matchGroups);
    }
  }

  sortMatches(matches);
  sortMatchGroups(matchGroups);
  return { matches, matchGroups, failures };
}

function addFailureForEveryQuery(
  failures: QueryFailure[],
  request: QueryStructureRequest,
  path: string,
  reason: QueryFailure['reason'],
  message: string,
): void {
  for (const query of request.queries) {
    failures.push({ path, queryId: query.id, reason, message });
  }
}

function sortMatches(matches: QueryMatch[]): void {
  matches.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    if (left.queryId < right.queryId) return -1;
    if (left.queryId > right.queryId) return 1;
    if (left.byteRange[0] !== right.byteRange[0]) {
      return left.byteRange[0] - right.byteRange[0];
    }
    return (left.captureIndex ?? 0) - (right.captureIndex ?? 0);
  });
}

function sortMatchGroups(groups: QueryMatchGroup[]): void {
  groups.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    if (left.queryId < right.queryId) return -1;
    if (left.queryId > right.queryId) return 1;
    if (left.patternIndex !== right.patternIndex) {
      return left.patternIndex - right.patternIndex;
    }
    return (
      (left.captures[0]?.byteRange[0] ?? 0) -
      (right.captures[0]?.byteRange[0] ?? 0)
    );
  });
}

function buildParseSignal(
  operationSignal: AbortSignal | undefined,
  timeoutMs: number,
): AbortSignal {
  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  if (operationSignal === undefined) return timeoutSignal;
  if (typeof AbortSignal.any === 'function') {
    return AbortSignal.any([operationSignal, timeoutSignal]);
  }

  const controller = new AbortController();
  if (operationSignal.aborted) {
    controller.abort(operationSignal.reason);
    return controller.signal;
  }
  if (timeoutSignal.aborted) {
    controller.abort(timeoutSignal.reason);
    return controller.signal;
  }
  const abort = (reason: unknown): void => {
    if (!controller.signal.aborted) controller.abort(reason);
    operationSignal.removeEventListener('abort', onOperationAbort);
    timeoutSignal.removeEventListener('abort', onTimeoutAbort);
  };
  const onOperationAbort = (): void => abort(operationSignal.reason);
  const onTimeoutAbort = (): void => abort(timeoutSignal.reason);
  operationSignal.addEventListener('abort', onOperationAbort, { once: true });
  timeoutSignal.addEventListener('abort', onTimeoutAbort, { once: true });
  return controller.signal;
}

function isAbortError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'AbortError') ||
    (error instanceof Error && error.name === 'AbortError')
  );
}

function isTimeoutError(error: unknown): boolean {
  return (
    (error instanceof DOMException && error.name === 'TimeoutError') ||
    (error instanceof Error && error.name === 'TimeoutError')
  );
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
