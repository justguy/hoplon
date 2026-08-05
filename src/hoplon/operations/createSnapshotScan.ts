import type { DlpAdapter } from '../adapters/dlp.js';
import type { SecretScannerAdapter } from '../adapters/secretScanner.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { DlpPolicyMode } from '../contracts/dlp.js';
import type { WritableManifest } from '../contracts/manifest.js';
import type { SnapshotWarning } from '../contracts/snapshot.js';
import { ValidationError } from '../contracts/errors.js';
import type { ManifestEntryBytes } from './createSnapshotIdentity.js';
import { scanDlpForEntry } from './createSnapshotDlp.js';

export interface SnapshotScanMetrics {
  anyFileRead: boolean;
  totalFileBytes: number;
  scopeCoveredBytes: number;
  totalLineCount: number;
}

interface ScanSnapshotArgs {
  manifest: WritableManifest;
  reads: ManifestEntryBytes[];
  secretScanner: SecretScannerAdapter;
  dlp: DlpAdapter | undefined;
  dlpMode: DlpPolicyMode;
  snapshotStore: SnapshotStore;
  snapshotId: string;
  engineId: string;
  signal: AbortSignal | undefined;
}

export async function scanSnapshotContent(
  args: ScanSnapshotArgs,
): Promise<{ warnings: SnapshotWarning[]; metrics: SnapshotScanMetrics }> {
  const {
    manifest,
    reads,
    secretScanner,
    dlp,
    dlpMode,
    snapshotStore,
    snapshotId,
    engineId,
    signal,
  } = args;
  const warnings: SnapshotWarning[] = [];
  const blockedPaths: Array<{ path: string }> = [];
  const metrics: SnapshotScanMetrics = {
    anyFileRead: false,
    totalFileBytes: 0,
    scopeCoveredBytes: 0,
    totalLineCount: 0,
  };

  for (const [entryIndex, entry] of manifest.entries.entries()) {
    const content = reads[entryIndex]?.bytes ?? null;
    if (content === null) continue;
    metrics.anyFileRead = true;
    metrics.totalFileBytes += content.byteLength;
    let newlineCount = 0;
    for (let index = 0; index < content.byteLength; index++) {
      if (content[index] === 0x0a) newlineCount++;
    }
    metrics.totalLineCount += content.byteLength === 0 ? 0 : newlineCount + 1;
    if (entry.scope.kind === 'whole_file') {
      metrics.scopeCoveredBytes += content.byteLength;
    }

    const findings = await secretScanner.scan({ path: entry.path, content });
    for (const finding of findings) {
      warnings.push({
        kind: 'possible_secret',
        path: entry.path,
        patternName: finding.patternName,
        lineNumber: finding.lineNumber,
        redactedSnippet: finding.redactedSnippet,
      });
    }
    const dlpResult = await scanDlpForEntry({
      dlp,
      mode: dlpMode,
      path: entry.path,
      content,
      ...(signal !== undefined ? { signal } : {}),
    });
    warnings.push(...dlpResult.warnings);
    for (const blocked of dlpResult.blockedFindings) {
      blockedPaths.push({ path: blocked.path });
    }
  }

  if (dlpMode === 'block' && blockedPaths.length > 0) {
    try {
      await snapshotStore.updateStatus(
        snapshotId,
        'failed',
        `dlp policy block: ${blockedPaths.length} finding(s)`,
      );
    } catch {
      // Leave pending for reconcile.
    }
    throw new ValidationError(
      {
        kind: 'dlp_policy_block',
        engineId,
        correlationId: manifest.correlationId,
      },
      `createSnapshot: DLP policy mode='block' rejected commit — ${blockedPaths.length} finding(s)`,
    );
  }
  return { warnings, metrics };
}
