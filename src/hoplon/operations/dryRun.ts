/** Evaluate proposed changes against a snapshot without mutating durable state. */

import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import { DryRunRequestSchema } from '../contracts/requests.js';
import type { DryRunRequest } from '../contracts/requests.js';
import type { DryRunResult } from '../contracts/invariantBinding.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import {
  classifyDryRunError,
  dryRunAbortError,
} from './dryRunErrors.js';
import { runDryRun } from './dryRunExecution.js';

export interface DryRunDeps {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  config: {
    fsRoot: string;
    gitRepoDir: string;
    maxFileBytes: number;
    parseTimeoutMs: number;
    manifestSchemaVersion: 1;
  };
}

export async function dryRun(
  deps: DryRunDeps,
  req: DryRunRequest,
  signal?: AbortSignal,
): Promise<DryRunResult> {
  const {
    versioning,
    snapshotStore,
    codeIntelligence,
    emitter,
    engineId,
    config,
  } = deps;
  const startMs = Date.now();
  if (signal?.aborted) throw dryRunAbortError(signal);

  const parseResult = DryRunRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const correlationId =
      typeof (req as Record<string, unknown>)?.['correlationId'] === 'string' &&
      ((req as Record<string, unknown>)?.['correlationId'] as string).length > 0
        ? ((req as Record<string, unknown>)['correlationId'] as string)
        : 'unvalidated';
    const error = new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId,
        cause: parseResult.error,
      },
      `dryRun: invalid request: ${parseResult.error.message}`,
    );
    emitter.emit({
      op: 'dryRun',
      phase: 'error',
      engineId,
      correlationId,
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_manifest',
    });
    throw error;
  }

  const validated = parseResult.data;
  try {
    validateCorrelationId(validated.correlationId);
  } catch (error) {
    emitter.emit({
      op: 'dryRun',
      phase: 'error',
      engineId,
      correlationId: validated.correlationId || 'unvalidated',
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_correlation_id',
    });
    throw error;
  }
  try {
    validateRunId(validated.runId);
  } catch (error) {
    emitter.emit({
      op: 'dryRun',
      phase: 'error',
      engineId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
      errorCategory: 'validation',
      errorKind: 'invalid_run_id',
    });
    throw error;
  }
  for (const change of validated.proposedChanges) {
    canonicalizePath({
      path: change.file,
      root: config.fsRoot,
      engineId,
      correlationId: validated.correlationId,
    });
  }

  emitter.emit({
    op: 'dryRun',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: DryRunResult;
  try {
    result = await runDryRun(
      { versioning, snapshotStore, codeIntelligence, engineId, config },
      validated,
      signal,
    );
  } catch (error) {
    const [errorCategory, errorKind] = classifyDryRunError(error);
    emitter.emit({
      op: 'dryRun',
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
    op: 'dryRun',
    phase: 'end',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs: Date.now() - startMs,
    classification: result.status,
  });
  return result;
}
