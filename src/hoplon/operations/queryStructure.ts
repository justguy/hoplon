/**
 * Execute tree-sitter Query DSL patterns against project files.
 *
 * Files and matches are sorted deterministically. Partial file, parse, and
 * query failures are returned in the result; malformed requests and escaping
 * paths remain thrown validation errors.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import { QueryStructureRequestSchema } from '../contracts/queryStructure.js';
import type {
  QueryStructureRequest,
  QueryStructureResult,
} from '../contracts/queryStructure.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { processQuery } from './queryStructureExecution.js';

export type { CodeIntelligenceAdapterWithLanguages } from './queryStructureRunner.js';

export interface QueryStructureDeps {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: {
    maxFileBytes: number;
    parseTimeoutMs: number;
  };
}

export async function queryStructure(
  deps: QueryStructureDeps,
  req: QueryStructureRequest,
  signal?: AbortSignal,
): Promise<QueryStructureResult> {
  const { fs, codeIntelligence, emitter, engineId, root, config } = deps;
  const startMs = Date.now();
  const parseResult = QueryStructureRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const correlationId =
      typeof req?.correlationId === 'string' && req.correlationId.length > 0
        ? req.correlationId
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId,
        cause: parseResult.error,
      },
      `queryStructure: invalid request: ${parseResult.error.message}`,
    );
  }

  const validated = parseResult.data;
  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);
  const canonicalPaths = validated.files.map((path) =>
    canonicalizePath({
      path,
      root,
      engineId,
      correlationId: validated.correlationId,
    }),
  );

  emitter.emit({
    op: 'queryStructure',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: QueryStructureResult;
  try {
    result = await processQuery({
      fs,
      codeIntelligence,
      config,
      validated,
      canonicalPaths,
      signal,
    });
  } catch (error) {
    emitter.emit({
      op: 'queryStructure',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
    });
    throw error;
  }

  emitter.emit({
    op: 'queryStructure',
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
