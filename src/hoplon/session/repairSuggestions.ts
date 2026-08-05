import type { AuditResult, AuditViolation } from '../contracts/audit.js';
import type { RepairSuggestion } from '../contracts/repairSuggestion.js';

export function composeRepairSuggestions(
  auditResult: AuditResult,
): RepairSuggestion[] {
  if (auditResult.status !== 'BLOCK') return [];
  return auditResult.violations.map((violation) => ({
    advisoryOnly: true,
    requiresConfirmation: true,
    action: actionForViolation(violation),
    violationKind: violation.kind,
    path: pathForViolation(violation),
    message: messageForViolation(violation),
    correctionAvailable:
      'correction' in violation &&
      typeof violation.correction === 'string' &&
      violation.correction.length > 0,
  }));
}

function actionForViolation(
  violation: AuditViolation,
): RepairSuggestion['action'] {
  if (violation.kind === 'TARGET_NOT_FOUND' || violation.kind === 'DUPLICATE_TARGET') {
    return 'inspect_target_identity';
  }
  if (violation.kind === 'uncontracted_file' || violation.kind === 'PATH_ESCAPE') {
    return 'revise_manifest_scope';
  }
  if (violation.kind === 'snapshot_missing') return 'rerun_with_fresh_snapshot';
  return 'retry_with_correction';
}

function pathForViolation(violation: AuditViolation): string | null {
  return 'path' in violation && typeof violation.path === 'string'
    ? violation.path
    : null;
}

function messageForViolation(violation: AuditViolation): string {
  if ('message' in violation && typeof violation.message === 'string') {
    return violation.message;
  }
  return `Audit violation ${violation.kind} requires caller-reviewed repair.`;
}
