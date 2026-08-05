import type { HoplonEvent } from '../adapters/emitter.js';
import type { AuditResult } from '../contracts/audit.js';
import type { PreflightResult } from '../contracts/preflight.js';
import { audit } from './sessionAuditMethods.js';
import { closeSession } from './sessionClose.js';
import { applyEdits, markEdited } from './sessionEditMethods.js';
import {
  getCloseoutProofBundle,
  getSnapshotEvidence,
} from './sessionEvidenceMethods.js';
import { touchedFilesFromChanges } from './sessionOverlay.js';
import { extractRollbackTemplate, revert } from './sessionRecoveryMethods.js';
import { getRepairContext } from './sessionRepairContext.js';
import { getReviewPayload, verifyBehavior } from './sessionReviewMethods.js';
import {
  buildRuntimeSnapshot,
} from './sessionRuntime.js';
import type { SessionRuntime } from './sessionRuntime.js';
import { stageContent } from './sessionStagedContent.js';
import { createSnapshot, dryRun, preflight } from './sessionStateMethods.js';
import type { DryRunResult, HoplonEditSession } from './types.js';

function statusClassification(
  status: 'PASS' | 'BLOCK',
): HoplonEvent['classification'] {
  return status;
}

function preflightDetails(result: PreflightResult) {
  return {
    classification: statusClassification(result.status),
    violationCount: result.gates.reduce(
      (sum, gate) => sum + gate.violations.length,
      0,
    ),
  };
}

function auditDetails(result: AuditResult | DryRunResult) {
  return {
    classification: statusClassification(result.status),
    violationCount: result.status === 'BLOCK' ? result.violations.length : 0,
  };
}

export function buildSessionFacade(runtime: SessionRuntime): HoplonEditSession {
  const telemetry = runtime.sessionTelemetry;
  return {
    sessionId: runtime.sessionId,
    get state() {
      return runtime.state;
    },
    get snapshot() {
      return buildRuntimeSnapshot(runtime);
    },
    preflight: () => telemetry.observeAsync(
      { op: 'preflight', operationKind: 'policy' },
      () => preflight(runtime),
      preflightDetails,
    ),
    createSnapshot: () => telemetry.observeAsync(
      { op: 'createSnapshot', operationKind: 'write' },
      () => createSnapshot(runtime),
      () => ({ classification: 'PASS', outputCount: 1 }),
    ),
    dryRun: (proposedChanges, opts) => telemetry.observeAsync(
      {
        op: 'dryRun',
        operationKind: 'policy',
        inputCount: proposedChanges.length,
        changedFileCount: touchedFilesFromChanges(proposedChanges).length,
      },
      () => dryRun(runtime, proposedChanges, opts),
      auditDetails,
    ),
    applyEdits: (proposedChanges) => telemetry.observeAsync(
      {
        op: 'applyEdits',
        operationKind: 'write',
        inputCount: proposedChanges.length,
      },
      () => applyEdits(runtime, proposedChanges),
      (result) => ({
        classification: 'PASS',
        changedFileCount: result.changedFiles.length,
        byteCount: result.bytesWritten,
      }),
    ),
    stageContent: (input) => telemetry.observeSync(
      {
        op: 'stageContent',
        operationKind: 'write',
        byteCount: input.chunkBytes.byteLength,
      },
      () => stageContent(runtime, input),
      (result) => ({
        classification: 'PASS',
        byteCount: result.bytesStaged,
        inputCount: result.chunks,
      }),
    ),
    markEdited: (files) => telemetry.observeAsync(
      { op: 'markEdited', operationKind: 'write', fileCount: files.length },
      () => markEdited(runtime, files),
      (result) => ({
        classification: 'PASS',
        changedFileCount: result.changedFiles.length,
      }),
    ),
    audit: () => telemetry.observeAsync(
      {
        op: 'auditDiff',
        operationKind: 'policy',
        fileCount: runtime.changedFiles.length,
      },
      () => audit(runtime),
      auditDetails,
    ),
    revert: () => telemetry.observeAsync(
      { op: 'revertUncontracted', operationKind: 'write' },
      () => revert(runtime),
      (result) => ({
        classification: 'PASS',
        changedFileCount:
          result.reverted.length +
          result.deleted.length +
          result.allowlistSkipped.length,
      }),
    ),
    extractRollbackTemplate: (opts) => telemetry.observeAsync(
      {
        op: 'extractRollbackTemplate',
        operationKind: 'read',
        fileCount: opts?.files?.length ?? runtime.changedFiles.length,
      },
      () => extractRollbackTemplate(runtime, opts),
      (result) => ({ classification: 'PASS', fileCount: result.files.length }),
    ),
    getRepairContext: (opts) => telemetry.observeAsync(
      { op: 'getRepairContext', operationKind: 'review' },
      () => getRepairContext(runtime, opts),
      () => ({ classification: 'PASS', outputCount: 1 }),
    ),
    getReviewPayload: (opts) => telemetry.observeAsync(
      { op: 'getReviewPayload', operationKind: 'review' },
      () => getReviewPayload(runtime, opts),
      () => ({ classification: 'PASS', outputCount: 1 }),
    ),
    verifyBehavior: (opts) => telemetry.observeAsync(
      { op: 'verifyBehavior', operationKind: 'analysis' },
      () => verifyBehavior(runtime, opts),
      (result) => {
        const classification =
          result.outcome === 'PASS' ? 'PASS'
          : result.outcome === 'FAIL' ? 'BLOCK'
          : null;
        return {
          ...(classification !== null ? { classification } : {}),
          resultCount:
            result.evidence.passingTestCount +
            result.evidence.skippedTestCount +
            result.evidence.failingTests.length,
        };
      },
    ),
    getSnapshotEvidence: (request) => telemetry.observeAsync(
      { op: 'getSnapshotEvidence', operationKind: 'read' },
      () => getSnapshotEvidence(runtime, request),
      () => ({ classification: 'PASS', outputCount: 1 }),
    ),
    getCloseoutProofBundle: (opts) => telemetry.observeAsync(
      { op: 'getCloseoutProofBundle', operationKind: 'review' },
      () => getCloseoutProofBundle(runtime, opts),
      () => ({ classification: 'PASS', outputCount: 1 }),
    ),
    close: () => closeSession(runtime),
  };
}
