import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { AuditViolation } from '../contracts/audit.js';
import type { MaterializedDryRunChange } from './dryRunMaterializeChanges.js';
import {
  buildDryRunParseSignal,
  classifyDryRunParseError,
  dryRunAbortError,
} from './dryRunErrors.js';
import { evaluateSymbolScopeGate, loadBaselineContent } from './symbolScopeGate.js';

interface EvaluateDryRunFilesArgs {
  changes: MaterializedDryRunChange[];
  record: SnapshotRecord;
  versioning: VersioningAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  gitRepoDir: string;
  maxFileBytes: number;
  parseTimeoutMs: number;
  signal: AbortSignal | undefined;
}

export async function evaluateDryRunFiles(
  args: EvaluateDryRunFilesArgs,
): Promise<AuditViolation[]> {
  const {
    changes,
    record,
    versioning,
    codeIntelligence,
    gitRepoDir,
    maxFileBytes,
    parseTimeoutMs,
    signal,
  } = args;
  const violations: AuditViolation[] = [];

  for (const change of changes) {
    if (signal?.aborted) throw dryRunAbortError(signal);
    const entry = record.manifest?.entries.find(
      (candidate) => candidate.path === change.file,
    );
    if (entry === undefined) {
      violations.push({
        kind: 'uncontracted_file',
        path: change.file,
        firstChangedLine: 1,
        sourceSlice: change.content,
        message: `File ${change.file} was proposed but is not in the contracted manifest.`,
        correction: `Revert all changes to ${change.file} — this file is not in the contracted manifest scope.`,
      });
      continue;
    }

    const proposedBytes = Buffer.from(change.content, 'utf8');
    if (proposedBytes.byteLength > maxFileBytes) {
      violations.push(parseViolation(change.file, 'file_too_large'));
      continue;
    }
    if (entry.scope.kind === 'whole_file') continue;

    let tree: Awaited<ReturnType<typeof codeIntelligence.parse>>;
    try {
      tree = await codeIntelligence.parse(
        change.file,
        new Uint8Array(proposedBytes),
        buildDryRunParseSignal(signal, parseTimeoutMs),
      );
    } catch (error) {
      const violation = classifyDryRunParseError(error, change.file);
      if (violation !== null) {
        violations.push(violation);
        continue;
      }
      throw error;
    }

    const contractedScope = entry.scope;
    if (contractedScope.kind !== 'symbols') continue;
    const baselineContent = await loadBaselineContent({
      versioning,
      gitRepoDir,
      gitRef: record.gitRef,
      file: change.file,
    });
    violations.push(
      ...(await evaluateSymbolScopeGate({
        file: change.file,
        contractedScope,
        codeIntelligence,
        currentTree: tree,
        currentContent: new Uint8Array(proposedBytes),
        baselineContent,
        baselineParseSignal: buildDryRunParseSignal(signal, parseTimeoutMs),
      })),
    );
  }
  return violations;
}

function parseViolation(path: string, parseError: string): AuditViolation {
  return {
    kind: 'parse_failure',
    path,
    parseError,
    nodeKind: null,
    message: `Could not parse ${path}: ${parseError}.`,
    correction: `Fix the syntax error in ${path} (${parseError}) so it can be parsed before retrying.`,
  };
}
