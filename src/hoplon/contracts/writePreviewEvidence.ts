import {
  createAdvisoryEvidenceState,
  createSampleBackedAdvisoryEvidenceState,
} from './advisoryIntelligence.js';
import type { ViolationPrediction } from './violationPredictor.js';
import type { WritePreviewViolationRiskReason } from './writePreviewIntelligence.js';

export function createWritePreviewRiskEvidenceState(
  status: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE',
  reason: WritePreviewViolationRiskReason | null,
  prediction: ViolationPrediction | null,
) {
  if (status === 'DEGRADED') {
    return createAdvisoryEvidenceState({
      status: 'DEGRADED',
      reason: reason ?? 'predict_failed',
    });
  }
  if (status === 'UNAVAILABLE') {
    return createAdvisoryEvidenceState({
      status: reason === 'not_requested' ? 'NO_VERDICT' : 'UNAVAILABLE',
      reason: reason ?? 'no_engine',
    });
  }
  return createSampleBackedAdvisoryEvidenceState({
    sampleSize: prediction?.sampleSize ?? 0,
    emptyReason: 'violation_risk_no_history',
  });
}
