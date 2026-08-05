/** Produce deterministic AST-bounded context through injected adapters. */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { PackedContext } from '../contracts/context.js';
import { PackContextRequestSchema } from '../contracts/requests.js';
import type { PackContextRequest } from '../contracts/requests.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { processPackedFiles } from './packContextExecution.js';
import { classifyPackContextError } from './packContextErrors.js';

export interface PackContextDeps {
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

export async function packContext(
  deps: PackContextDeps,
  req: PackContextRequest,
  signal?: AbortSignal,
): Promise<PackedContext> {
  const { fs, codeIntelligence, emitter, engineId, root, config } = deps;
  const startMs = Date.now();
  const parseResult = PackContextRequestSchema.safeParse(req);
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
      `packContext: invalid request: ${parseResult.error.message}`,
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
    op: 'packContext',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: PackedContext;
  try {
    result = await processPackedFiles({
      fs,
      codeIntelligence,
      config,
      validated,
      canonicalPaths,
      signal,
    });
  } catch (error) {
    const [errorCategory, errorKind] = classifyPackContextError(error);
    emitter.emit({
      op: 'packContext',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
      ...(errorCategory !== undefined ? { errorCategory } : {}),
      ...(errorKind !== undefined ? { errorKind } : {}),
    });
    throw error;
  }

  emitter.emit({
    op: 'packContext',
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
