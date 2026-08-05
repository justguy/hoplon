/**
 * session/postEditPolicy.ts - advisory post-edit content policy composition.
 */

import {
  PostEditPolicyFindingSchema,
  PostEditPolicyScanSidecarSchema,
  createPostEditPolicyUnavailable,
  type PostEditPolicyFinding,
  type PostEditPolicyScanInput,
  type PostEditPolicyScanSidecar,
  type PostEditPolicyScanner,
} from '../contracts/postEditPolicy.js';
import {
  createAdvisoryEvidenceState,
  createAdvisoryIntelligenceAuthority,
  createStrictAgentIntelligenceAccess,
} from '../contracts/advisoryIntelligence.js';
import type { ReviewPayloadPhase } from '../contracts/reviewPayload.js';

export interface ComposePostEditPolicySidecarInput {
  readonly includePostEditPolicyScan: boolean;
  readonly scanner: PostEditPolicyScanner | null;
  readonly phase: ReviewPayloadPhase;
  readonly files: readonly {
    readonly path: string;
    readonly before: Uint8Array | null;
    readonly after: Uint8Array | null;
  }[];
  readonly signal?: AbortSignal | undefined;
}

export async function composePostEditPolicySidecar(
  input: ComposePostEditPolicySidecarInput,
): Promise<PostEditPolicyScanSidecar> {
  if (!input.includePostEditPolicyScan) {
    return createPostEditPolicyUnavailable('not_requested');
  }
  if (input.scanner === null) {
    return createPostEditPolicyUnavailable('no_scanner');
  }
  if (input.files.length === 0) {
    return createPostEditPolicyUnavailable('no_changed_files');
  }

  const scannedFiles: string[] = [];
  const findings: PostEditPolicyFinding[] = [];
  try {
    for (const file of input.files) {
      scannedFiles.push(file.path);
      const scanInput: PostEditPolicyScanInput = {
        path: file.path,
        beforeBytes: file.before,
        afterBytes: file.after,
        phase: input.phase,
      };
      const rawFindings = await input.scanner.scan(scanInput, input.signal);
      for (const finding of rawFindings) {
        findings.push(PostEditPolicyFindingSchema.parse(finding));
      }
    }
  } catch {
    const detail = 'scanner failed before producing redacted findings';
    return PostEditPolicyScanSidecarSchema.parse({
      version: 1,
      advisory: true,
      status: 'DEGRADED',
      provider: {
        providerId: input.scanner.providerId,
        status: 'degraded',
        reason: 'scanner_failed',
        detail,
      },
      evidence: createAdvisoryEvidenceState({
        status: 'DEGRADED',
        reason: 'scanner_failed',
        detail,
      }),
      reason: 'scanner_failed',
      scannedFiles,
      findings: [],
      authority: createAdvisoryIntelligenceAuthority(),
      strictAgentAccess: createStrictAgentIntelligenceAccess(),
    });
  }

  return PostEditPolicyScanSidecarSchema.parse({
    version: 1,
    advisory: true,
    status: findings.length > 0 ? 'AVAILABLE' : 'EMPTY',
    provider: {
      providerId: input.scanner.providerId,
      status: 'available',
      reason: null,
      detail: null,
    },
    evidence:
      findings.length > 0
        ? createAdvisoryEvidenceState({
            status: 'AVAILABLE',
            detail: `${findings.length} redacted finding(s)`,
          })
        : createAdvisoryEvidenceState({
            status: 'EMPTY',
            reason: 'no_findings',
          }),
    reason: findings.length > 0 ? null : 'no_findings',
    scannedFiles,
    findings,
    authority: createAdvisoryIntelligenceAuthority(),
    strictAgentAccess: createStrictAgentIntelligenceAccess(),
  });
}
