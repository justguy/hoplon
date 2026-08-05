import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { AuditViolation } from '../contracts/audit.js';
import {
  auditAbortError,
  auditParseViolation,
  buildAuditParseSignal,
  classifyAuditParseError,
} from './auditDiffErrors.js';
import {
  createAuditMetricState,
  finalizeAuditMetrics,
  recordAuditFileRead,
  recordAuditTree,
  type AuditMetrics,
} from './auditDiffMetrics.js';
import { evaluateSymbolScopeGate, loadBaselineContent } from './symbolScopeGate.js';

interface EvaluateAuditFilesArgs {
  files: string[];
  record: SnapshotRecord;
  fs: HoplonFsAdapter;
  versioning: VersioningAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  gitRepoDir: string;
  maxFileBytes: number;
  parseTimeoutMs: number;
  signal: AbortSignal | undefined;
}

export async function evaluateAuditFiles(
  args: EvaluateAuditFilesArgs,
): Promise<{ violations: AuditViolation[]; metrics: AuditMetrics }> {
  const {
    files,
    record,
    fs,
    versioning,
    codeIntelligence,
    gitRepoDir,
    maxFileBytes,
    parseTimeoutMs,
    signal,
  } = args;
  const violations: AuditViolation[] = [];
  const metrics = createAuditMetricState();

  for (const file of files) {
    if (signal?.aborted) throw auditAbortError(signal);
    const entry = record.manifest?.entries.find(
      (candidate) => candidate.path === file,
    );
    if (entry === undefined) {
      let sourceSlice = '';
      try {
        sourceSlice = new TextDecoder('utf-8').decode(await fs.read(file));
      } catch {
        sourceSlice = '';
      }
      violations.push({
        kind: 'uncontracted_file',
        path: file,
        firstChangedLine: 1,
        sourceSlice,
        message: `File ${file} was modified but is not in the contracted manifest.`,
        correction: `Revert all changes to ${file} — this file is not in the contracted manifest scope.`,
      });
      continue;
    }

    let content: Uint8Array;
    try {
      content = await fs.read(file);
    } catch (error) {
      violations.push(
        auditParseViolation(
          file,
          error instanceof Error ? error.message : String(error),
        ),
      );
      continue;
    }
    if (content.byteLength > maxFileBytes) {
      violations.push(auditParseViolation(file, 'file_too_large'));
      continue;
    }

    recordAuditFileRead(metrics, content, entry.scope.kind === 'whole_file');
    if (entry.scope.kind === 'whole_file') continue;

    let tree: Awaited<ReturnType<typeof codeIntelligence.parse>>;
    try {
      tree = await codeIntelligence.parse(
        file,
        content,
        buildAuditParseSignal(signal, parseTimeoutMs),
      );
    } catch (error) {
      const violation = classifyAuditParseError(error, file);
      if (violation !== null) {
        violations.push(violation);
        continue;
      }
      throw error;
    }

    recordAuditTree(metrics, tree.rootNode);
    const contractedScope = entry.scope;
    if (contractedScope.kind !== 'symbols') continue;
    const baselineContent = await loadBaselineContent({
      versioning,
      gitRepoDir,
      gitRef: record.gitRef,
      file,
    });
    violations.push(
      ...(await evaluateSymbolScopeGate({
        file,
        contractedScope,
        codeIntelligence,
        currentTree: tree,
        currentContent: content,
        baselineContent,
        baselineParseSignal: buildAuditParseSignal(signal, parseTimeoutMs),
      })),
    );
  }
  return { violations, metrics: finalizeAuditMetrics(metrics) };
}
