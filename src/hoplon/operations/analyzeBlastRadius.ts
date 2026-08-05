/**
 * operations/analyzeBlastRadius.ts — t-027 advisory blast-radius consumer.
 *
 * Advisory cross-file reporting over the existing `CodeIntelligenceAdapter`
 * seam. For each caller-supplied symbol, calls `findReferences`, aggregates
 * counts, and classifies each row against the explicit warn threshold.
 *
 * ## What this operation is and is not
 * - Advisory only. `result.advisory` is schema-pinned to `true` and every
 *   caller can see `result.status` / per-entry `classification`. No
 *   `auditDiff` / `createSnapshot` / `dryRun` / `preflight` code path
 *   consults this output for PASS/BLOCK.
 * - Composes the shipped default `CodeIntelligenceAdapter` — no new
 *   reference-analysis mechanism. When the adapter does not implement
 *   `findReferences` (e.g., the tree-sitter default on its own) the
 *   operation returns `status: 'UNAVAILABLE'` with every entry classified
 *   `missing_provider`; it never throws and never fabricates counts.
 *
 * ## Threshold surface
 * The effective threshold is always echoed on the result and on every
 * entry (`thresholdUsed`). The reference default
 * (`DEFAULT_BLAST_RADIUS_WARN_THRESHOLD`) only applies when the caller
 * omits `warnThreshold`; an explicit `0` means "warn on any reference".
 *
 * ## Event discipline (H11, H13)
 * - op: 'analyzeBlastRadius'
 * - phases: start / end / error
 * - counts only — no symbol names, no paths, no content
 */

import type { HoplonEmitter } from '../adapters/emitter.js';
import type {
  CodeIntelligenceAdapter,
  Reference,
  Symbol as CiSymbol,
} from '../adapters/codeIntelligence.js';
import {
  AnalyzeBlastRadiusRequestSchema,
  AnalyzeBlastRadiusResultSchema,
  DEFAULT_BLAST_RADIUS_WARN_THRESHOLD,
  type AnalyzeBlastRadiusRequest,
  type AnalyzeBlastRadiusResult,
  type BlastRadiusEntry,
  type BlastRadiusSymbol,
} from '../contracts/blastRadius.js';
import {
  ValidationError,
  AdapterError,
  EngineError,
  SemanticError,
} from '../contracts/errors.js';
import { validateCorrelationId } from '../util/validators.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface AnalyzeBlastRadiusDeps {
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  config?: {
    /**
     * Optional engine-level override for the reference default.
     * When the request also omits `warnThreshold`, this value is used instead
     * of `DEFAULT_BLAST_RADIUS_WARN_THRESHOLD`. Explicit request thresholds
     * always win. Keeping the override here preserves the "no silent default
     * change" rule: the host has to pass it in deliberately.
     */
    defaultWarnThreshold?: number;
  };
}

// ---------------------------------------------------------------------------
// analyzeBlastRadius
// ---------------------------------------------------------------------------

export async function analyzeBlastRadius(
  deps: AnalyzeBlastRadiusDeps,
  req: AnalyzeBlastRadiusRequest,
  signal?: AbortSignal,
): Promise<AnalyzeBlastRadiusResult> {
  const parsed = AnalyzeBlastRadiusRequestSchema.safeParse(req);
  if (!parsed.success) {
    const corrId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string' &&
      ((req as { correlationId?: string }).correlationId ?? '').length > 0
        ? (req as { correlationId: string }).correlationId
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: corrId,
        cause: parsed.error,
      },
      `analyzeBlastRadius: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);

  const effectiveThreshold =
    request.warnThreshold ??
    deps.config?.defaultWarnThreshold ??
    DEFAULT_BLAST_RADIUS_WARN_THRESHOLD;

  const start = Date.now();
  const emitBase = {
    engineId: deps.engineId,
    correlationId: request.correlationId,
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
  };

  deps.emitter.emit({
    op: 'analyzeBlastRadius',
    phase: 'start',
    ...emitBase,
  });

  try {
    if (signal?.aborted) {
      throw _abortError(signal);
    }

    const providerAvailable =
      typeof deps.codeIntelligence.findReferences === 'function';

    const entries: BlastRadiusEntry[] = providerAvailable
      ? await _collectEntries(
          deps.codeIntelligence,
          request.symbols,
          effectiveThreshold,
          signal,
        )
      : request.symbols.map((s) => _missingProviderEntry(s, effectiveThreshold));

    const hasWarning = entries.some((e) => e.classification === 'warning');
    const status: AnalyzeBlastRadiusResult['status'] = providerAvailable
      ? hasWarning
        ? 'WARNING'
        : 'SAFE'
      : 'UNAVAILABLE';

    const result: AnalyzeBlastRadiusResult = {
      correlationId: request.correlationId,
      advisory: true,
      status,
      providerAvailable,
      warnThreshold: effectiveThreshold,
      entries,
    };

    // Re-validate our own output so the contract is enforced end-to-end.
    // A future refactor that accidentally flips `advisory` or produces a
    // non-finite count is caught here rather than at the caller.
    const validated = AnalyzeBlastRadiusResultSchema.safeParse(result);
    if (!validated.success) {
      throw new ValidationError(
        {
          kind: 'invalid_manifest',
          engineId: deps.engineId,
          correlationId: request.correlationId,
          cause: validated.error,
        },
        `analyzeBlastRadius: produced invalid result: ${validated.error.message}`,
      );
    }

    deps.emitter.emit({
      op: 'analyzeBlastRadius',
      phase: 'end',
      ...emitBase,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });

    return validated.data;
  } catch (err) {
    deps.emitter.emit({
      op: 'analyzeBlastRadius',
      phase: 'error',
      ...emitBase,
      durationMs: Date.now() - start,
      ..._classifyError(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function _collectEntries(
  adapter: CodeIntelligenceAdapter,
  symbols: readonly BlastRadiusSymbol[],
  threshold: number,
  signal: AbortSignal | undefined,
): Promise<BlastRadiusEntry[]> {
  // findReferences existence is checked by the caller before we enter here.
  // The cast narrows to the optional method without smuggling in a non-null
  // assertion at every call site.
  const findReferences = adapter.findReferences!;
  const out: BlastRadiusEntry[] = [];

  for (const symbol of symbols) {
    if (signal?.aborted) {
      throw _abortError(signal);
    }

    const ciSymbol: CiSymbol = {
      name: symbol.name,
      kind: symbol.kind,
      byteRange: symbol.byteRange,
    };
    const refs = await findReferences.call(adapter, ciSymbol);
    out.push(_classify(symbol, refs, threshold));
  }
  return out;
}

function _classify(
  symbol: BlastRadiusSymbol,
  refs: readonly Reference[],
  threshold: number,
): BlastRadiusEntry {
  const uniqueFiles = Array.from(new Set(refs.map((r) => r.path))).sort();
  const referenceCount = refs.length;
  // Warning iff there is at least one reference AND the count meets the
  // threshold. The `referenceCount > 0` clause keeps a `threshold: 0` call
  // sensible — zero references should never surface as warning.
  const classification: BlastRadiusEntry['classification'] =
    referenceCount > 0 && referenceCount >= threshold ? 'warning' : 'safe';
  return {
    symbol,
    classification,
    referenceCount,
    affectedFileCount: uniqueFiles.length,
    affectedFiles: uniqueFiles,
    thresholdUsed: threshold,
  };
}

function _missingProviderEntry(
  symbol: BlastRadiusSymbol,
  threshold: number,
): BlastRadiusEntry {
  return {
    symbol,
    classification: 'missing_provider',
    referenceCount: 0,
    affectedFileCount: 0,
    affectedFiles: [],
    thresholdUsed: threshold,
  };
}

function _abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}

function _classifyError(
  err: unknown,
): { errorCategory?: 'engine' | 'adapter' | 'semantic' | 'validation'; errorKind?: string } {
  if (err instanceof ValidationError) {
    return { errorCategory: 'validation', errorKind: err.kind };
  }
  if (err instanceof AdapterError) {
    return { errorCategory: 'adapter', errorKind: err.kind };
  }
  if (err instanceof EngineError) {
    return { errorCategory: 'engine', errorKind: err.kind };
  }
  if (err instanceof SemanticError) {
    return { errorCategory: 'semantic', errorKind: err.kind };
  }
  return { errorCategory: 'adapter', errorKind: 'find_references_failed' };
}
