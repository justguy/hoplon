import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { SnapshotRecord } from '../adapters/snapshotStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { AuditViolation } from '../contracts/audit.js';
import type { MaterializedDryRunChange } from './dryRunMaterializeChanges.js';
import { checkSignatures } from './checkSignatures.js';
import { validateImports } from './validateImports.js';

interface DryRunPostChecksArgs {
  versioning: VersioningAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  record: SnapshotRecord;
  resolvedChanges: MaterializedDryRunChange[];
  gitRepoDir: string;
  signal: AbortSignal | undefined;
}

export async function runDryRunPostChecks(
  args: DryRunPostChecksArgs,
): Promise<AuditViolation[]> {
  const {
    versioning,
    codeIntelligence,
    record,
    resolvedChanges,
    gitRepoDir,
    signal,
  } = args;
  const violations: AuditViolation[] = [];
  if (record.gitRef !== null) {
    const importResult = await validateImports(
      { versioning, codeIntelligence, gitRepoDir, gitRef: record.gitRef },
      resolvedChanges,
      signal,
    );
    for (const violation of importResult.violations) {
      if (
        violation.kind === 'IMPORT_TARGET_NOT_FOUND' ||
        violation.kind === 'IMPORT_SYMBOL_NOT_EXPORTED'
      ) {
        violations.push(violation);
      }
    }
  }

  const signatureResult = await checkSignatures(
    { codeIntelligence },
    resolvedChanges,
    record.manifest?.signatureContracts,
    signal,
  );
  for (const violation of signatureResult.violations) {
    if (violation.kind === 'SIGNATURE_MISMATCH') violations.push(violation);
  }
  return violations;
}
