/**
 * operations/createSnapshotDlp.ts — t-026 DLP scan helper for createSnapshot.
 *
 * Keeps the main createSnapshot file below the architecture 300-line cap and
 * concentrates the DLP seam wiring in one place. Additive only — never invoked
 * when no adapter is supplied or when `mode === 'disabled'`.
 *
 * ## Behaviour
 * - `mode === 'disabled'` → adapter is never invoked; returns empty results.
 * - `mode === 'warn'`     → findings are re-validated via `DlpFindingSchema`
 *                           and mapped to `possible_dlp_finding` warnings.
 * - `mode === 'block'`    → findings are re-validated, accumulated, and the
 *                           caller is expected to inspect `blockedFindings`
 *                           after all entries are scanned. This helper does
 *                           NOT throw — createSnapshot owns the throw site so
 *                           it can update the snapshot row to `failed` before
 *                           rejecting with `ValidationError{dlp_policy_block}`.
 *
 * The helper never reads raw content into operational events or logs. The only
 * surface that leaves this file is redacted snippets + closed-enum metadata.
 */

import type { DlpAdapter } from '../adapters/dlp.js';
import {
  DlpFindingSchema,
  type DlpFinding,
  type DlpPolicyMode,
} from '../contracts/dlp.js';
import type { SnapshotWarning } from '../contracts/snapshot.js';

export interface ScanDlpForEntryArgs {
  dlp: DlpAdapter | undefined;
  mode: DlpPolicyMode;
  path: string;
  content: Uint8Array;
  signal?: AbortSignal;
}

export interface ScanDlpForEntryResult {
  warnings: SnapshotWarning[];
  blockedFindings: Array<{ path: string; finding: DlpFinding }>;
}

const EMPTY: ScanDlpForEntryResult = Object.freeze({
  warnings: [],
  blockedFindings: [],
}) as unknown as ScanDlpForEntryResult;

export async function scanDlpForEntry(
  args: ScanDlpForEntryArgs,
): Promise<ScanDlpForEntryResult> {
  const { dlp, mode, path, content, signal } = args;
  if (mode === 'disabled' || dlp === undefined) return EMPTY;

  const raw = await dlp.scan({ path, content }, signal);
  if (raw.length === 0) {
    return { warnings: [], blockedFindings: [] };
  }

  const warnings: SnapshotWarning[] = [];
  const blockedFindings: Array<{ path: string; finding: DlpFinding }> = [];

  for (const candidate of raw) {
    // Re-validate at the operation boundary so a buggy adapter can't leak an
    // unredacted value or a non-enum classification past this seam.
    const finding = DlpFindingSchema.parse(candidate);
    if (mode === 'warn') {
      warnings.push({
        kind: 'possible_dlp_finding',
        path,
        ruleId: finding.ruleId,
        classification: finding.classification,
        ...(finding.confidence !== undefined
          ? { confidence: finding.confidence }
          : {}),
        lineNumber: finding.lineNumber,
        redactedSnippet: finding.redactedSnippet,
      });
    } else {
      // mode === 'block'
      blockedFindings.push({ path, finding });
    }
  }

  return { warnings, blockedFindings };
}
