/**
 * operations/getRelevantTests.ts — LC10 getRelevantTests pure function.
 *
 * Static test oracle: given a set of modified files, determines which test
 * files in the project import them (directly or transitively within maxDepth
 * hops). Uses queryStructure (CI3-3) to extract import graphs via tree-sitter
 * S-expression queries.
 *
 * ## Algorithm
 *   1. Recursively scan the fs root to collect all JS/TS source files.
 *   2. Run STD_QUERY_IMPORTS against all collected files via queryStructure.
 *   3. Run DYNAMIC_REQUIRE_QUERIES — any hit sets coverageConfidence to 'conservative'.
 *   4. Build a forward import graph: file → Set<resolved relative imports>.
 *   5. Identify test files by matching testPatterns substrings against the path.
 *   6. For each test file, BFS forward through the import graph up to maxDepth
 *      to check whether it reaches any modifiedFile.
 *   7. relevantTests ← sorted test files that reach ≥1 modifiedFile.
 *   8. unusedModifiedFiles ← sorted modifiedFiles not reached by any test.
 *
 * Internal helpers (file collection, graph building, BFS) live in
 * getRelevantTestsInternal.ts per the 300-line law.
 *
 * ## Determinism (H7)
 *   relevantTests and unusedModifiedFiles are sorted before return.
 *
 * ## H13 compliance
 *   HoplonEvent payloads contain structure only (counts, status).
 *
 * ## H2 compliance
 *   All I/O goes through the injected fs and codeIntelligence adapters.
 *
 * ## Import wall
 *   Imports only from ../adapters/*, ../contracts/*, ../util/*, and sibling ops.
 *   Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import { GetRelevantTestsRequestSchema } from '../contracts/getRelevantTests.js';
import type {
  GetRelevantTestsRequest,
  TestOracleResult,
} from '../contracts/getRelevantTests.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import type { RelevantTestsSemanticSearch } from './getRelevantTestsSemanticAdvisory.js';
import { runRelevantTestsCore } from './getRelevantTestsRun.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface GetRelevantTestsDeps {
  /** Filesystem adapter (C2). */
  fs: HoplonFsAdapter;
  /** Code intelligence adapter (D3). */
  codeIntelligence: CodeIntelligenceAdapter;
  /** Operational event emitter (C5). */
  emitter: HoplonEmitter;
  /** Engine identity (H5). */
  engineId: string;
  /** Trusted root directory for path operations (H9). */
  root: string;
  config: {
    maxFileBytes: number;
    parseTimeoutMs: number;
  };
  semanticSearch?: RelevantTestsSemanticSearch;
}

// ---------------------------------------------------------------------------
// getRelevantTests — main entry point
// ---------------------------------------------------------------------------

/**
 * Determine which test files in the project are relevant to the modified files.
 *
 * Pure: all side-effects go through injected adapters.
 * Deterministic: sorted output (H7).
 *
 * @throws {ValidationError} kind 'invalid_manifest' — request fails Zod parse
 * @throws {ValidationError} kind 'invalid_correlation_id' — correlationId invalid
 * @throws {ValidationError} kind 'invalid_run_id' — runId invalid
 * @throws {DOMException}    name 'AbortError' — signal aborted
 */
export async function getRelevantTests(
  deps: GetRelevantTestsDeps,
  req: GetRelevantTestsRequest,
  signal?: AbortSignal,
): Promise<TestOracleResult> {
  const { fs, codeIntelligence, emitter, engineId, root, config } = deps;
  const startMs = Date.now();

  if (signal?.aborted) throw _abortError(signal);

  // Step 1: Validate request
  const parseResult = GetRelevantTestsRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const corrId =
      typeof (req as Record<string, unknown>)?.['correlationId'] === 'string' &&
      ((req as Record<string, unknown>)?.['correlationId'] as string).length > 0
        ? ((req as Record<string, unknown>)['correlationId'] as string)
        : 'unvalidated';
    throw new ValidationError(
      { kind: 'invalid_manifest', engineId, correlationId: corrId, cause: parseResult.error },
      `getRelevantTests: invalid request: ${parseResult.error.message}`,
    );
  }
  const validated = parseResult.data;

  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);

  emitter.emit({
    op: 'getRelevantTests',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: TestOracleResult;
  try {
    result = await runRelevantTestsCore({
      fs, codeIntelligence, emitter, engineId, root, config, validated, signal,
      testPatternsProvided: Object.hasOwn(req as object, 'testPatterns'),
      ...(deps.semanticSearch !== undefined ? { semanticSearch: deps.semanticSearch } : {}),
    });
  } catch (err) {
    emitter.emit({
      op: 'getRelevantTests',
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
    op: 'getRelevantTests',
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

// ---------------------------------------------------------------------------
// Internal: AbortSignal helper
// ---------------------------------------------------------------------------

function _abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}
