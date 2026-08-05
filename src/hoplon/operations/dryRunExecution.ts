import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { AuditViolation } from '../contracts/audit.js';
import type { DryRunResult } from '../contracts/invariantBinding.js';
import type { DryRunRequest } from '../contracts/requests.js';
import { evaluateInvariantBindings } from './invariantBinding.js';
import { evaluateDryRunFiles } from './dryRunFileEvaluation.js';
import { materializeDryRunChanges } from './dryRunMaterializeChanges.js';
import { runDryRunPostChecks } from './dryRunPostChecks.js';
import { resolveDryRunSnapshot } from './dryRunSnapshot.js';

interface RunDryRunDeps {
  versioning: VersioningAdapter;
  snapshotStore: SnapshotStore;
  codeIntelligence: CodeIntelligenceAdapter;
  engineId: string;
  config: {
    gitRepoDir: string;
    maxFileBytes: number;
    parseTimeoutMs: number;
    manifestSchemaVersion: 1;
  };
}

export async function runDryRun(
  deps: RunDryRunDeps,
  request: DryRunRequest,
  signal: AbortSignal | undefined,
): Promise<DryRunResult> {
  const { versioning, snapshotStore, codeIntelligence, engineId, config } = deps;
  const record = await resolveDryRunSnapshot(
    snapshotStore,
    request,
    engineId,
    config.manifestSchemaVersion,
  );
  const sortedChanges = request.proposedChanges
    .map((change, index) => ({ change, index }))
    .sort((left, right) =>
      left.change.file < right.change.file
        ? -1
        : left.change.file > right.change.file
          ? 1
          : left.index - right.index,
    )
    .map(({ change }) => change);
  const { resolvedChanges, resolutionViolations } =
    await materializeDryRunChanges({
      changes: sortedChanges,
      versioning,
      codeIntelligence,
      gitRepoDir: config.gitRepoDir,
      gitRef: record.gitRef,
      signal,
    });
  const invariantReport =
    request.invariantBindings !== undefined
      ? await evaluateInvariantBindings({
          codeIntelligence,
          changes: resolvedChanges,
          invariants: request.invariantBindings,
          signal,
        })
      : undefined;
  const violations: AuditViolation[] = [...resolutionViolations];
  violations.push(
    ...(await evaluateDryRunFiles({
      changes: resolvedChanges,
      record,
      versioning,
      codeIntelligence,
      gitRepoDir: config.gitRepoDir,
      maxFileBytes: config.maxFileBytes,
      parseTimeoutMs: config.parseTimeoutMs,
      signal,
    })),
  );
  violations.push(
    ...(await runDryRunPostChecks({
      versioning,
      codeIntelligence,
      record,
      resolvedChanges,
      gitRepoDir: config.gitRepoDir,
      signal,
    })),
  );

  if (violations.length === 0) {
    return {
      status: 'PASS',
      checked: request.proposedChanges.length,
      auditSchemaVersion: 1,
      correlationId: request.correlationId,
      ...(invariantReport !== undefined ? { invariantReport } : {}),
    };
  }
  return {
    status: 'BLOCK',
    violations,
    auditSchemaVersion: 1,
    correlationId: request.correlationId,
    ...(invariantReport !== undefined ? { invariantReport } : {}),
  };
}
