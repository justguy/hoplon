/** t-118 advisory referencing lookup over CodeIntelligenceAdapter.findReferences. */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter, Reference } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import {
  FindReferencingSymbolsRequestSchema,
  FindReferencingSymbolsResultSchema,
  type FindReferencingSymbolsRequest,
  type FindReferencingSymbolsResult,
  type ReferencingSymbolIdentity,
  type ReferencingSymbolReference,
  type ReferencingSymbolTargetResolution,
} from '../contracts/referencingSymbols.js';
import { ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId } from '../util/validators.js';

export interface FindReferencingSymbolsDeps {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: { maxFileBytes: number; parseTimeoutMs: number };
}

export async function findReferencingSymbols(
  deps: FindReferencingSymbolsDeps,
  req: FindReferencingSymbolsRequest,
  signal?: AbortSignal,
): Promise<FindReferencingSymbolsResult> {
  const parsed = FindReferencingSymbolsRequestSchema.safeParse(req);
  if (!parsed.success) {
    const correlationId = readCorrelationId(req);
    throw new ValidationError(
      { kind: 'invalid_manifest', engineId: deps.engineId, correlationId, cause: parsed.error },
      `findReferencingSymbols: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);

  const start = Date.now();
  deps.emitter.emit({
    op: 'findReferencingSymbols',
    phase: 'start',
    engineId: deps.engineId,
    projectId: request.projectId,
    correlationId: request.correlationId,
  });

  try {
    if (signal?.aborted) throw abortError(signal);
    const targetResolution = await resolveTarget(deps, request, signal);
    const result = await buildResult(deps, request, targetResolution, signal);
    const validated = FindReferencingSymbolsResultSchema.safeParse(result);
    if (!validated.success) {
      throw new ValidationError(
        {
          kind: 'invalid_manifest',
          engineId: deps.engineId,
          correlationId: request.correlationId,
          cause: validated.error,
        },
        `findReferencingSymbols: produced invalid result: ${validated.error.message}`,
      );
    }
    deps.emitter.emit({
      op: 'findReferencingSymbols',
      phase: 'end',
      engineId: deps.engineId,
      projectId: request.projectId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });
    return validated.data;
  } catch (err) {
    deps.emitter.emit({
      op: 'findReferencingSymbols',
      phase: 'error',
      engineId: deps.engineId,
      projectId: request.projectId,
      correlationId: request.correlationId,
      durationMs: Date.now() - start,
    });
    throw err;
  }
}

async function buildResult(
  deps: FindReferencingSymbolsDeps,
  request: FindReferencingSymbolsRequest,
  targetResolution: ReferencingSymbolTargetResolution,
  signal: AbortSignal | undefined,
): Promise<FindReferencingSymbolsResult> {
  const findReferences = deps.codeIntelligence.findReferences;
  const providerStatus = typeof findReferences === 'function' ? 'available' : 'unavailable';
  if (targetResolution.status === 'ambiguous') {
    return emptyResult(request, 'AMBIGUOUS_TARGET', providerStatus, targetResolution);
  }
  if (targetResolution.status === 'unresolved') {
    return emptyResult(request, 'UNRESOLVED_TARGET', providerStatus, targetResolution);
  }
  if (targetResolution.status === 'unsupported' || targetResolution.symbol === null) {
    return emptyResult(request, 'UNSUPPORTED_TARGET', providerStatus, targetResolution);
  }
  if (providerStatus === 'unavailable' || findReferences === undefined) {
    return emptyResult(request, 'UNAVAILABLE', 'unavailable', targetResolution);
  }

  let rawReferences: Reference[];
  try {
    rawReferences = await findReferences.call(deps.codeIntelligence, {
      name: targetResolution.symbol.name,
      kind: targetResolution.symbol.kind,
      byteRange: targetResolution.symbol.byteRange,
    });
  } catch {
    return {
      ...emptyResult(request, 'PROVIDER_ERROR', 'error', targetResolution),
      providerError: { kind: 'find_references_failed' },
    };
  }

  const references: ReferencingSymbolReference[] = [];
  for (const ref of rawReferences) {
    if (signal?.aborted) throw abortError(signal);
    references.push(await enrichReference(deps, ref, request.correlationId, signal));
  }
  const files = Array.from(new Set(references.map((ref) => ref.path))).sort();
  return {
    correlationId: request.correlationId,
    advisory: true,
    status: 'AVAILABLE',
    providerStatus: 'available',
    targetResolution,
    references,
    files,
    referenceCount: references.length,
    providerError: null,
  };
}

async function resolveTarget(
  deps: FindReferencingSymbolsDeps,
  request: FindReferencingSymbolsRequest,
  signal: AbortSignal | undefined,
): Promise<ReferencingSymbolTargetResolution> {
  const target = request.target;
  if (target.type === 'symbol_identity') {
    return {
      status: 'resolved',
      symbol: target.symbol,
      candidates: [target.symbol],
      reason: 'direct_symbol',
    };
  }
  const pathOk = validatePath(deps, target.path, request.correlationId);
  if (!pathOk) return unresolved('unsupported', 'invalid_path');
  const stat = await deps.fs.stat(target.path);
  if (!stat.exists) return unresolved('unresolved', 'file_not_found');
  if (!stat.isFile || stat.size > deps.config.maxFileBytes) {
    return unresolved('unsupported', 'file_too_large');
  }

  let symbols: ReferencingSymbolIdentity[];
  try {
    const content = await deps.fs.read(target.path);
    const tree = await deps.codeIntelligence.parse(target.path, content, signal);
    symbols = deps.codeIntelligence
      .getTopLevelSymbols(tree)
      .filter((s) => s.name === target.name && (target.kind === undefined || s.kind === target.kind))
      .map((s) => ({ name: s.name, kind: s.kind, byteRange: s.byteRange, path: target.path }));
  } catch {
    return unresolved('unsupported', 'parse_failed');
  }

  if (symbols.length === 0) return unresolved('unresolved', 'no_matching_symbol');
  if (symbols.length > 1) {
    return {
      status: 'ambiguous',
      symbol: null,
      candidates: symbols,
      reason: 'multiple_matching_symbols',
    };
  }
  return {
    status: 'resolved',
    symbol: symbols[0]!,
    candidates: symbols,
    reason: 'matched_symbol',
  };
}

async function enrichReference(
  deps: FindReferencingSymbolsDeps,
  ref: Reference,
  correlationId: string,
  signal: AbortSignal | undefined,
): Promise<ReferencingSymbolReference> {
  const base = { path: ref.path, byteRange: ref.byteRange };
  if (!validatePath(deps, ref.path, correlationId)) {
    return { ...base, containingSymbol: null, symbolResolution: 'invalid_path' };
  }
  const stat = await deps.fs.stat(ref.path);
  if (!stat.exists) {
    return { ...base, containingSymbol: null, symbolResolution: 'file_not_found' };
  }
  if (!stat.isFile || stat.size > deps.config.maxFileBytes) {
    return { ...base, containingSymbol: null, symbolResolution: 'file_too_large' };
  }
  try {
    const content = await deps.fs.read(ref.path);
    const tree = await deps.codeIntelligence.parse(ref.path, content, signal);
    const enclosing = deps.codeIntelligence
      .getTopLevelSymbols(tree)
      .filter((s) => containsRange(s.byteRange, ref.byteRange))
      .sort((a, b) => rangeSize(a.byteRange) - rangeSize(b.byteRange))[0];
    if (!enclosing) {
      return { ...base, containingSymbol: null, symbolResolution: 'no_enclosing_symbol' };
    }
    return {
      ...base,
      containingSymbol: {
        name: enclosing.name,
        kind: enclosing.kind,
        byteRange: enclosing.byteRange,
        path: ref.path,
      },
      symbolResolution: 'resolved',
    };
  } catch {
    return { ...base, containingSymbol: null, symbolResolution: 'parse_failed' };
  }
}

function emptyResult(
  request: FindReferencingSymbolsRequest,
  status: FindReferencingSymbolsResult['status'],
  providerStatus: FindReferencingSymbolsResult['providerStatus'],
  targetResolution: ReferencingSymbolTargetResolution,
): FindReferencingSymbolsResult {
  return {
    correlationId: request.correlationId,
    advisory: true,
    status,
    providerStatus,
    targetResolution,
    references: [],
    files: [],
    referenceCount: 0,
    providerError: null,
  };
}

function unresolved(
  status: ReferencingSymbolTargetResolution['status'],
  reason: NonNullable<ReferencingSymbolTargetResolution['reason']>,
): ReferencingSymbolTargetResolution {
  return { status, symbol: null, candidates: [], reason };
}

function validatePath(
  deps: FindReferencingSymbolsDeps,
  path: string,
  correlationId: string,
): boolean {
  try {
    canonicalizePath({ path, root: deps.root, engineId: deps.engineId, correlationId });
    return true;
  } catch {
    return false;
  }
}

function containsRange(container: [number, number], child: [number, number]): boolean {
  return container[0] <= child[0] && container[1] >= child[1];
}

function rangeSize(range: [number, number]): number {
  return range[1] - range[0];
}

function readCorrelationId(req: unknown): string {
  if (!req || typeof req !== 'object') return 'validator';
  const value = (req as { correlationId?: unknown }).correlationId;
  return typeof value === 'string' ? value : 'validator';
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(typeof reason === 'string' ? reason : 'Operation aborted', 'AbortError');
}
