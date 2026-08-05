/**
 * operations/seeCodebasePaths.ts — path-specific execution helpers for
 * `seeCodebase`.
 *
 * Keeps path execution separate from routing / planning so the main
 * orchestrator stays under the 300-line architecture cap.
 */

import type {
  SeeCodebasePrimitiveId,
  SeeCodebaseRequestValidated,
  SeeCodebaseResult,
  SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import { executeAstNodeTargets } from './seeCodebaseAstNode.js';
import { liveFsProvenance } from './seeCodebaseProvenance.js';
import type { SeeCodebaseDeps } from './seeCodebase.js';

export async function executeStructuralPath(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  targets: readonly SeeCodebaseTarget[],
  signal: AbortSignal | undefined,
  results: SeeCodebaseResult[],
  used: Set<SeeCodebasePrimitiveId>,
): Promise<void> {
  await executeAstNodeTargets(deps, request, targets, signal, results, used);

  for (const target of targets) {
    if (target.kind === 'ast_node') continue;
    if (target.kind === 'project') {
      const payload = await deps.describeProject({
        projectId: request.projectId,
        runId: request.runId,
        correlationId: request.correlationId,
      }, signal);
      results.push({
        kind: 'structural',
        primitive: 'describeProject',
        payload,
        // project scope walks the workspace tree; no single-file provenance.
        readProvenance: liveFsProvenance(deps.root),
      });
      used.add('describeProject');
      continue;
    }
    if (target.kind === 'symbol') {
      const payload = await deps.searchSymbols({
        projectId: request.projectId,
        runId: request.runId,
        correlationId: request.correlationId,
        namePattern: anchoredRegex(target.name),
        ...(typeof target.file === 'string' ? { files: [target.file] } : {}),
      }, signal);
      results.push({
        kind: 'structural',
        primitive: 'searchSymbols',
        payload,
        // When scoped to a specific file, the read is provably single-file;
        // otherwise the primitive walks the workspace symbol corpus.
        readProvenance: liveFsProvenance(
          deps.root,
          typeof target.file === 'string' ? target.file : undefined,
        ),
      });
      used.add('searchSymbols');
      continue;
    }
    if (target.kind !== 'file') continue;
    const payload = await deps.packContext({
      projectId: request.projectId,
      runId: request.runId,
      correlationId: request.correlationId,
      files: [target.path],
      strategy: { kind: 'whole_file' },
    }, signal);
    results.push({
      kind: 'structural',
      primitive: 'packContext',
      payload,
      readProvenance: liveFsProvenance(deps.root, target.path),
    });
    used.add('packContext');
  }
}

export async function executeSkeletonPath(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  targets: readonly SeeCodebaseTarget[],
  signal: AbortSignal | undefined,
  results: SeeCodebaseResult[],
  used: Set<SeeCodebasePrimitiveId>,
): Promise<void> {
  const files = Array.from(new Set(targets.flatMap((target) => {
    if (target.kind === 'file') return [target.path];
    if (target.kind === 'symbol' && typeof target.file === 'string') return [target.file];
    return [];
  })));
  if (files.length === 0) return;
  const payload = await deps.extractStructuralTemplate({
    projectId: request.projectId,
    runId: request.runId,
    correlationId: request.correlationId,
    files,
  }, signal);
  results.push({
    kind: 'skeleton',
    primitive: 'extractStructuralTemplate',
    payload,
    // Single-file templates carry a filePath; multi-file batches omit it and
    // surface the workspace root only (honest per-result granularity).
    readProvenance: liveFsProvenance(
      deps.root,
      files.length === 1 ? files[0] : undefined,
    ),
  });
  used.add('extractStructuralTemplate');
}

export function estimateResultBytes(results: readonly SeeCodebaseResult[]): number {
  let total = 0;
  for (const result of results) {
    if (result.kind === 'raw_file') total += result.bytes;
    else if (result.kind === 'edit_slice') {
      total += Buffer.byteLength(result.content, 'utf8');
    }
    else if (result.kind === 'ast_node') {
      total += Buffer.byteLength(result.content, 'utf8');
    } else if (result.kind === 'raw_search') {
      for (const match of result.matches) total += Buffer.byteLength(match.text, 'utf8');
    } else {
      total += Buffer.byteLength(JSON.stringify(result.payload ?? {}), 'utf8');
    }
  }
  return total;
}

function anchoredRegex(literal: string): string {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `^${escaped}$`;
}
