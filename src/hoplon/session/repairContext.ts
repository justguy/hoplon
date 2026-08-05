/**
 * session/repairContext.ts — package a failed-audit session's authoritative
 * evidence into a reusable host-facing RepairContext DTO (t-070).
 *
 * This is the single place the packaging happens. The session method
 * `getRepairContext` delegates here so contracts stay declarative and
 * assembly stays linear. The helper does not mutate any session state; it
 * takes already-captured session fields plus carried-through metadata and
 * assembles a deep-cloned DTO.
 *
 * Invariants enforced by the caller (the session):
 *   - `auditResult.status === 'BLOCK'`
 *   - `rollbackTemplate` is the output of `extractRollbackTemplate()` against
 *     the same session and snapshotRef
 *   - `sessionHistory` is the append-only ordered transition log from the
 *     failed session (copied here to preserve cross-session readability)
 *
 * This helper itself does not validate those invariants because the session
 * is the only legal caller. A future direct user would go through the Zod
 * schema at the DTO boundary instead.
 */

import type { AuditResult } from '../contracts/audit.js';
import type { DependencyImpactSidecar } from '../contracts/dependencyImpact.js';
import type { VerifyBehaviorResult } from '../contracts/verifyBehavior.js';
import type { VerificationSemanticGapSidecar } from '../contracts/verificationIntelligence.js';
import type {
  FailedAttemptRef,
  NextAttemptPlan,
  RepairContext,
} from '../contracts/repairContext.js';
import type { RollbackTemplate } from '../contracts/rollbackTemplate.js';
import { composeVerificationSemanticGapSidecar } from '../contracts/verificationIntelligence.js';
import { composeRetryContextCompression } from './retryContextCompression.js';
import { composeRepairSuggestions } from './repairSuggestions.js';
import { cloneValue } from './internal.js';
import type { SessionTransition } from './types.js';

export interface PackageRepairContextInput {
  readonly sessionId: string;
  readonly attemptNumber: number;
  readonly snapshotRef: string;
  readonly failedAtMs: number;
  readonly correlationId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly auditResult: AuditResult;
  readonly rollbackTemplate: RollbackTemplate;
  readonly priorSessionHistory: readonly SessionTransition[];
  readonly generatedAtIso: string;
  readonly executionId: string | null;
  readonly attemptId: string | null;
  readonly auditRef: string | null;
  /**
   * Optional canonical advisory dependency-impact sidecar (t-077). When
   * supplied, the packaged context echoes it verbatim — this helper never
   * recomputes or fabricates impact evidence. Omit to keep pre-t-077
   * behaviour (field absent from the DTO).
   */
  readonly dependencyImpact?: DependencyImpactSidecar;
  /**
   * Optional failed behavior proof to carry into the repair context as the
   * t-104 semantic-gap sidecar. The helper reads only the supplied
   * VerifyBehaviorResult DTO; test execution and any host file reads remain
   * outside this packaging step.
   */
  readonly behaviorVerification?: VerifyBehaviorResult;
  /**
   * Optional precomposed sidecar for hosts that already built it. When both
   * this and `behaviorVerification` are supplied, the explicit sidecar wins.
   */
  readonly verificationSemanticGap?: VerificationSemanticGapSidecar;
  readonly includeRetryContextCompression?: boolean;
}

export function packageRepairContext(input: PackageRepairContextInput): RepairContext {
  const failedAttempt: FailedAttemptRef = {
    sessionId: input.sessionId,
    attemptNumber: input.attemptNumber,
    snapshotRef: input.snapshotRef,
    failedAtMs: input.failedAtMs,
    executionId: input.executionId,
    attemptId: input.attemptId,
    auditRef: input.auditRef,
  };
  const nextAttempt: NextAttemptPlan = {
    attemptNumber: input.attemptNumber + 1,
    baselineSnapshotRef: input.snapshotRef,
  };
  const verificationSemanticGap =
    input.verificationSemanticGap ??
    composeRepairVerificationSemanticGap(input.behaviorVerification);
  const retryContextCompression =
    input.includeRetryContextCompression === true
      ? composeRetryContextCompression({
          auditResult: input.auditResult,
          behaviorVerification: input.behaviorVerification,
        })
      : null;
  const repairSuggestions = composeRepairSuggestions(input.auditResult);
  return {
    repairContextSchemaVersion: 1,
    correlationId: input.correlationId,
    projectId: input.projectId,
    runId: input.runId,
    failedAttempt,
    auditResult: cloneValue(input.auditResult),
    rollbackTemplate: cloneValue(input.rollbackTemplate),
    priorSessionHistory: cloneValue([...input.priorSessionHistory]),
    nextAttempt,
    generatedAt: input.generatedAtIso,
    ...(input.dependencyImpact !== undefined
      ? { dependencyImpact: cloneValue(input.dependencyImpact) }
      : {}),
    ...(input.behaviorVerification !== undefined
      ? { behaviorVerification: cloneValue(input.behaviorVerification) }
      : {}),
    ...(verificationSemanticGap !== null
      ? { verificationSemanticGap: cloneValue(verificationSemanticGap) }
      : {}),
    ...(retryContextCompression !== null
      ? { retryContextCompression: cloneValue(retryContextCompression) }
      : {}),
    ...(repairSuggestions.length > 0
      ? { repairSuggestions: cloneValue(repairSuggestions) }
      : {}),
  };
}

function composeRepairVerificationSemanticGap(
  verification: VerifyBehaviorResult | undefined,
): VerificationSemanticGapSidecar | null {
  if (verification === undefined || verification.outcome !== 'FAIL') return null;
  return composeVerificationSemanticGapSidecar({
    verification,
    includeSemanticGapIntelligence: true,
  });
}
