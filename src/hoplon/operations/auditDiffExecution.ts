import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { AuditResult } from '../contracts/audit.js';
import type { AuditRequest } from '../contracts/requests.js';
import { evaluateAuditFiles } from './auditDiffFileEvaluation.js';
import type { AuditMetrics } from './auditDiffMetrics.js';
import { resolveAuditSnapshot } from './auditDiffSnapshot.js';

interface RunAuditDeps {
  fs: HoplonFsAdapter;
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

export async function runAudit(
  deps: RunAuditDeps,
  request: AuditRequest,
  signal: AbortSignal | undefined,
): Promise<{ result: AuditResult; metrics: AuditMetrics }> {
  const { fs, versioning, snapshotStore, codeIntelligence, engineId, config } =
    deps;
  const record = await resolveAuditSnapshot(
    snapshotStore,
    request,
    engineId,
    config.manifestSchemaVersion,
  );
  const { violations, metrics } = await evaluateAuditFiles({
    files: [...request.files].sort(),
    record,
    fs,
    versioning,
    codeIntelligence,
    gitRepoDir: config.gitRepoDir,
    maxFileBytes: config.maxFileBytes,
    parseTimeoutMs: config.parseTimeoutMs,
    signal,
  });
  const result: AuditResult =
    violations.length === 0
      ? {
          status: 'PASS',
          checked: request.files.length,
          auditSchemaVersion: 1,
          correlationId: request.correlationId,
        }
      : {
          status: 'BLOCK',
          violations,
          auditSchemaVersion: 1,
          correlationId: request.correlationId,
        };
  return { result, metrics };
}
