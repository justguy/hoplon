import { createAdvisoryEvidenceState } from './advisoryIntelligence.js';
import type { VerifyBehaviorResult } from './verifyBehavior.js';

export function deriveVerificationEvidenceState(
  verification: VerifyBehaviorResult,
) {
  if (verification.outcome === 'NOT_RUN') {
    return createAdvisoryEvidenceState({
      status: 'NO_VERDICT',
      reason: verification.unavailabilityReason ?? 'behavior_not_run',
    });
  }
  if (verification.status === 'UNAVAILABLE') {
    return createAdvisoryEvidenceState({
      status: 'UNAVAILABLE',
      reason: verification.unavailabilityReason ?? 'verification_unavailable',
    });
  }
  const reason = deriveVerificationDegradationReason(verification);
  if (reason !== null) {
    return createAdvisoryEvidenceState({ status: 'DEGRADED', reason });
  }
  if (verification.selection.testsExecuted.length === 0) {
    return createAdvisoryEvidenceState({
      status: 'EMPTY',
      reason: 'no_tests_executed',
    });
  }
  return createAdvisoryEvidenceState({ status: 'AVAILABLE' });
}

function deriveVerificationDegradationReason(
  verification: VerifyBehaviorResult,
): string | null {
  if (verification.status === 'DEGRADED') {
    return verification.unavailabilityReason ?? 'runner_degraded';
  }
  if (verification.selection.oracleResult === null) return 'oracle_unavailable';
  if (verification.selection.coverageConfidence === 'conservative') {
    return 'conservative_coverage';
  }
  return null;
}
