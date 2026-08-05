/** Shared advisory dependency-impact sidecar composer. */

import type { AnalyzeBlastRadiusResult, BlastRadiusSymbol } from '../contracts/blastRadius.js';
import type {
  DependencyImpactReason,
  DependencyImpactSidecar,
  DependencyImpactSubject,
  DependencyImpactSymbolSubject,
} from '../contracts/dependencyImpact.js';
import { createAdvisoryEvidenceState } from '../contracts/advisoryIntelligence.js';
import type { HoplonEngine } from '../engine/types.js';

export interface ComposeDependencyImpactSidecarInput {
  readonly subjects: readonly DependencyImpactSubject[];
  readonly includeDependencyImpact: boolean;
  readonly engine: HoplonEngine | null;
  readonly correlationId: string;
  readonly projectId: string;
  readonly warnThreshold?: number | undefined;
  readonly precomputedChangedFiles?: readonly string[] | undefined;
  readonly signal?: AbortSignal | undefined;
}

const MAX_ADAPTER_ERROR_DETAIL_CHARS = 512;

function truncate(message: string): string {
  if (message.length <= MAX_ADAPTER_ERROR_DETAIL_CHARS) return message;
  return `${message.slice(0, MAX_ADAPTER_ERROR_DETAIL_CHARS - 3)}...`;
}

function countSubjects(
  subjects: readonly DependencyImpactSubject[],
): { symbol: number; file: number } {
  let symbol = 0;
  let file = 0;
  for (const s of subjects) {
    if (s.kind === 'symbol') symbol += 1;
    else file += 1;
  }
  return { symbol, file };
}

// ---------------------------------------------------------------------------
// composeDependencyImpactSidecar — the shared composer
// ---------------------------------------------------------------------------

export async function composeDependencyImpactSidecar(
  input: ComposeDependencyImpactSidecarInput,
): Promise<DependencyImpactSidecar> {
  const subjects = mergePrecomputedChangedFiles(
    input.subjects,
    input.precomputedChangedFiles ?? [],
  );
  const subjectCounts = countSubjects(subjects);

  if (!input.includeDependencyImpact) {
    return {
      version: 1,
      advisory: true,
      status: 'UNAVAILABLE',
      evidence: createAdvisoryEvidenceState({
        status: 'NO_VERDICT',
        reason: 'not_requested',
      }),
      reason: 'not_requested',
      detail: null,
      subjects,
      subjectCounts,
      blastRadius: null,
      warnThreshold: null,
    };
  }

  if (input.engine === null) {
    return {
      version: 1,
      advisory: true,
      status: 'UNAVAILABLE',
      evidence: createAdvisoryEvidenceState({
        status: 'UNAVAILABLE',
        reason: 'no_engine',
      }),
      reason: 'no_engine',
      detail: null,
      subjects,
      subjectCounts,
      blastRadius: null,
      warnThreshold: null,
    };
  }

  if (subjects.length === 0) {
    return {
      version: 1,
      advisory: true,
      status: 'UNAVAILABLE',
      evidence: createAdvisoryEvidenceState({
        status: 'EMPTY',
        reason: 'no_changed_subjects',
      }),
      reason: 'no_changed_subjects',
      detail: null,
      subjects,
      subjectCounts,
      blastRadius: null,
      warnThreshold: null,
    };
  }

  const symbolSubjects = subjects.filter(
    (s): s is DependencyImpactSymbolSubject => s.kind === 'symbol',
  );

  if (symbolSubjects.length === 0) {
    return {
      version: 1,
      advisory: true,
      status: 'DEGRADED',
      evidence: createAdvisoryEvidenceState({
        status: 'DEGRADED',
        reason: 'file_only_fallback',
      }),
      reason: 'file_only_fallback',
      detail: null,
      subjects,
      subjectCounts,
      blastRadius: null,
      warnThreshold: null,
    };
  }

  const blastRadiusSymbols = dedupSymbolSubjects(symbolSubjects);

  let result: AnalyzeBlastRadiusResult;
  try {
    const req: Parameters<HoplonEngine['analyzeBlastRadius']>[0] = {
      correlationId: input.correlationId,
      projectId: input.projectId,
      symbols: blastRadiusSymbols,
      ...(input.warnThreshold !== undefined
        ? { warnThreshold: input.warnThreshold }
        : {}),
    };
    result = await input.engine.analyzeBlastRadius(req, input.signal);
  } catch (err) {
    const detail =
      err instanceof Error ? truncate(err.message) : truncate(String(err));
    return {
      version: 1,
      advisory: true,
      status: 'DEGRADED',
      evidence: createAdvisoryEvidenceState({
        status: 'DEGRADED',
        reason: 'analyze_failed',
        detail,
      }),
      reason: 'analyze_failed',
      detail,
      subjects,
      subjectCounts,
      blastRadius: null,
      warnThreshold: input.warnThreshold ?? null,
    };
  }

  const warnThreshold = result.warnThreshold;
  const hasFileOnlySubjects = subjectCounts.file > 0;
  const hasMissingProvider = result.entries.some(
    (e) => e.classification === 'missing_provider',
  );

  let status: 'AVAILABLE' | 'DEGRADED';
  let reason: DependencyImpactReason | null = null;

  if (result.status === 'UNAVAILABLE' || !result.providerAvailable) {
    status = 'DEGRADED';
    reason = 'no_provider';
  } else if (hasFileOnlySubjects && hasMissingProvider) {
    status = 'DEGRADED';
    reason = 'partial_symbol_resolution';
  } else if (hasFileOnlySubjects) {
    status = 'DEGRADED';
    reason = 'file_only_fallback';
  } else if (hasMissingProvider) {
    status = 'DEGRADED';
    reason = 'partial_symbol_resolution';
  } else {
    status = 'AVAILABLE';
    reason = null;
  }

  return {
    version: 1,
    advisory: true,
    status,
    evidence:
      status === 'AVAILABLE'
        ? createAdvisoryEvidenceState({ status: 'AVAILABLE' })
        : createAdvisoryEvidenceState({
            status: 'DEGRADED',
            reason: reason ?? 'dependency_impact_degraded',
          }),
    reason,
    detail: null,
    subjects,
    subjectCounts,
    blastRadius: result,
    warnThreshold,
  };
}

function mergePrecomputedChangedFiles(
  subjects: readonly DependencyImpactSubject[],
  precomputedChangedFiles: readonly string[],
): DependencyImpactSubject[] {
  const merged = [...subjects];
  const seen = new Set(merged.map((subject) => subject.path));
  for (const path of precomputedChangedFiles) {
    if (seen.has(path)) continue;
    seen.add(path);
    merged.push({
      kind: 'file',
      path,
      origin: 'tree_diff_precompute',
      reason: 'tree_diff_changed_file',
    });
  }
  return merged;
}

function dedupSymbolSubjects(
  subjects: readonly DependencyImpactSymbolSubject[],
): BlastRadiusSymbol[] {
  const seen = new Set<string>();
  const out: BlastRadiusSymbol[] = [];
  for (const s of subjects) {
    const key = `${s.path}::${s.symbolName}::${s.byteRange[0]}::${s.byteRange[1]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({
      name: s.symbolName,
      kind: s.symbolKind,
      byteRange: s.byteRange,
      path: s.path,
    });
  }
  return out;
}
