/**
 * Build a deterministic structural skeleton from live or snapshotted files.
 * All I/O remains behind injected adapters; captured source never enters events.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import { ExtractStructuralTemplateRequestSchema } from '../contracts/structuralTemplate.js';
import type {
  ExtractStructuralTemplateRequest,
  StructuralTemplate,
} from '../contracts/structuralTemplate.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { processStructuralTemplate } from './extractStructuralTemplateExecution.js';

export {
  DEFAULT_TEMPLATE_QUERY_ID,
  STD_QUERY_TYPES,
} from './structuralTemplateQueries.js';

export interface ExtractStructuralTemplateDeps {
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: {
    maxFileBytes: number;
    parseTimeoutMs: number;
    gitRepoDir: string;
  };
}

export async function extractStructuralTemplate(
  deps: ExtractStructuralTemplateDeps,
  req: ExtractStructuralTemplateRequest,
  signal?: AbortSignal,
): Promise<StructuralTemplate> {
  const { emitter, engineId, root } = deps;
  const startMs = Date.now();
  const parseResult = ExtractStructuralTemplateRequestSchema.safeParse(req);
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
      `extractStructuralTemplate: invalid request: ${parseResult.error.message}`,
    );
  }

  const validated = parseResult.data;
  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);
  validated.files.forEach((path) =>
    canonicalizePath({
      path,
      root,
      engineId,
      correlationId: validated.correlationId,
    }),
  );
  if (signal?.aborted) throw abortError(signal);

  emitter.emit({
    op: 'extractStructuralTemplate',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: StructuralTemplate;
  try {
    result = await processStructuralTemplate({ deps, validated, signal });
  } catch (error) {
    emitter.emit({
      op: 'extractStructuralTemplate',
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
    op: 'extractStructuralTemplate',
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

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}
