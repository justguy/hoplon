/**
 * operations/extractRollbackTemplate.ts — LC11 extractRollbackTemplate pure function.
 *
 * Composes extractStructuralTemplate (LC4) to produce per-file structural
 * skeletons of the reverted state as a retry reference template.
 * (recs §15.11 — "Rollback Template Injection")
 *
 * ## Purpose
 *   After revertUncontracted(), the filesystem is precisely at the snapshot
 *   state. extractRollbackTemplate reads the structural skeleton of each
 *   reverted file from the snapshot (via extractStructuralTemplate snapshot
 *   mode) and packages it with:
 *     - contractedChanges: what the manifest scope permitted for this file
 *     - injectionHint: directive sentence for the retry prompt
 *
 *   Injected into the retry prompt alongside violation descriptions, the
 *   agent sees:
 *     - What the file looked like before (structuralSkeleton)
 *     - What went wrong (violations from the prior audit)
 *     - What to change (contractedChanges — derived from manifest scope)
 *     - What to leave alone (everything not described in contractedChanges)
 *
 * ## LC4 composition
 *   This operation is a thin orchestration layer over extractStructuralTemplate.
 *   It passes snapshotRefId so LC4 reads from the git object store (not live FS).
 *   The StructuralTemplate returned by LC4 is serialized to a compact string
 *   (structuralSkeleton) for each file.
 *
 * ## Determinism (H7)
 *   Output files are sorted by path ascending.
 *   Same (snapshotRefId, files, contractedChangesMap) → byte-identical output.
 *   structuralSkeleton derives from extractStructuralTemplate which is H7.
 *
 * ## H13 compliance
 *   HoplonEvent payloads contain structure only (counts, status).
 *   structuralSkeleton / contractedChanges / injectionHint are NOT in events.
 *
 * ## H2 compliance
 *   All I/O goes through injected adapters (via extractStructuralTemplate).
 *   This function performs no direct filesystem, git, or lock operations.
 *
 * ## Import wall
 *   Imports only from ../adapters/*, ../contracts/*, ../util/*,
 *   and ./extractStructuralTemplate.js.
 *   Never from src/pipeline/**, src/agents/**, or Phalanx orchestration layers.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import {
  ExtractRollbackTemplateRequestSchema,
} from '../contracts/rollbackTemplate.js';
import type {
  ExtractRollbackTemplateRequest,
  RollbackTemplate,
} from '../contracts/rollbackTemplate.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { processRollbackTemplate } from './extractRollbackTemplateExecution.js';
export { DEFAULT_INJECTION_HINT } from './extractRollbackTemplateExecution.js';

// ---------------------------------------------------------------------------
// Default injection hint — always non-empty (LC11-H1 invariant)
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface ExtractRollbackTemplateDeps {
  /** Filesystem adapter (C2) — passed through to extractStructuralTemplate. */
  fs: HoplonFsAdapter;
  /** VersioningAdapter (C4) — used via extractStructuralTemplate for snapshot readBlob. */
  versioning: VersioningAdapter;
  /** SQLite snapshot store (C1) — used via extractStructuralTemplate to resolve snapshot. */
  snapshotStore: SnapshotStore;
  /** Code intelligence adapter (D3). */
  codeIntelligence: CodeIntelligenceAdapter;
  /** Operational event emitter (C5). */
  emitter: HoplonEmitter;
  /** Engine identity (H5). */
  engineId: string;
  /** Trusted root for H9 path canonicalization. */
  root: string;
  /** Resource limits. */
  config: {
    maxFileBytes: number;
    parseTimeoutMs: number;
    gitRepoDir: string;
  };
}

// ---------------------------------------------------------------------------
// extractRollbackTemplate — main entry point
// ---------------------------------------------------------------------------

/**
 * Extract per-file structural rollback templates from a committed snapshot.
 *
 * Composes extractStructuralTemplate (LC4) in snapshot mode.
 * Returns a RollbackTemplate with per-file skeletons + injection hints.
 *
 * Pure: all side-effects go through injected adapters.
 * Deterministic: same (snapshotRefId, files, contractedChangesMap) → byte-identical output (H7).
 *
 * @throws {ValidationError} kind 'invalid_manifest' — request fails Zod parse
 * @throws {ValidationError} kind 'invalid_correlation_id' — correlationId invalid
 * @throws {ValidationError} kind 'invalid_run_id' — runId invalid
 * @throws {ValidationError} kind 'path_traversal' — any path escapes root
 * @throws {SemanticError} kind 'snapshot_missing' — snapshotRefId not in store or not committed
 * @throws {DOMException} name 'AbortError' — signal aborted
 */
export async function extractRollbackTemplate(
  deps: ExtractRollbackTemplateDeps,
  req: ExtractRollbackTemplateRequest,
  signal?: AbortSignal,
): Promise<RollbackTemplate> {
  const { emitter, engineId, root } = deps;
  const startMs = Date.now();

  // -------------------------------------------------------------------------
  // Step 1: Validate request via Zod
  // -------------------------------------------------------------------------
  const parseResult = ExtractRollbackTemplateRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const corrId =
      typeof req?.correlationId === 'string' && req.correlationId.length > 0
        ? req.correlationId
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId: corrId,
        cause: parseResult.error,
      },
      `extractRollbackTemplate: invalid request: ${parseResult.error.message}`,
    );
  }
  const validated = parseResult.data;

  // -------------------------------------------------------------------------
  // Step 2: Validate identity strings
  // -------------------------------------------------------------------------
  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);

  // -------------------------------------------------------------------------
  // Step 3: Canonicalize paths (H9)
  // -------------------------------------------------------------------------
  validated.files.forEach((p) =>
    canonicalizePath({
      path: p,
      root,
      engineId,
      correlationId: validated.correlationId,
    }),
  );

  // -------------------------------------------------------------------------
  // Step 4: Abort check (H12)
  // -------------------------------------------------------------------------
  if (signal?.aborted) {
    throw _abortError(signal);
  }

  // -------------------------------------------------------------------------
  // Step 5: Emit start event (H11, H13 — structure only)
  // -------------------------------------------------------------------------
  emitter.emit({
    op: 'extractRollbackTemplate',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  // -------------------------------------------------------------------------
  // Main processing — wrapped to emit error event on any throw
  // -------------------------------------------------------------------------
  let result: RollbackTemplate;
  try {
    result = await processRollbackTemplate({ deps, validated, signal });
  } catch (err) {
    const durationMs = Date.now() - startMs;
    emitter.emit({
      op: 'extractRollbackTemplate',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs,
    });
    throw err;
  }

  // -------------------------------------------------------------------------
  // Step 9: Emit end event (H11, H13 — structure only)
  // -------------------------------------------------------------------------
  const durationMs = Date.now() - startMs;
  emitter.emit({
    op: 'extractRollbackTemplate',
    phase: 'end',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs,
    classification: 'PASS',
  });

  return result;
}

// ---------------------------------------------------------------------------
// Internal: AbortSignal helpers (H12)
// ---------------------------------------------------------------------------

function _abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}
