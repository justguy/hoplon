/** Typed client for packaged `/session/*` routes. */

import {
  InspectSessionResponseSchema,
  ListSessionsResponseSchema,
  QuickEditResultDataSchema,
  SessionApplyEditsRequestSchema,
  SessionDryRunRequestSchema,
  SessionExtractRollbackTemplateRequestSchema,
  SessionMarkEditedRequestSchema,
  SessionQuickEditRequestSchema,
  SessionRefSchema,
  SessionSnapshotEvidenceRequestSchema,
  SessionStageContentRequestSchema,
  SessionVerifyBehaviorRequestSchema,
  StartSessionRequestSchema,
} from '../../session/transportContracts.js';
import {
  dispatchSessionRequest,
  resolveSessionClientOptions,
} from './sessionClientDispatch.js';
import {
  APPLY_EDITS_RESPONSE_SCHEMA,
  AUDIT_RESPONSE_SCHEMA,
  CLOSE_RESPONSE_SCHEMA,
  CREATE_SNAPSHOT_RESPONSE_SCHEMA,
  DRY_RUN_RESPONSE_SCHEMA,
  EXTRACT_ROLLBACK_TEMPLATE_RESPONSE_SCHEMA,
  GET_REPAIR_CONTEXT_RESPONSE_SCHEMA,
  GET_SNAPSHOT_EVIDENCE_RESPONSE_SCHEMA,
  MARK_EDITED_RESPONSE_SCHEMA,
  PREFLIGHT_RESPONSE_SCHEMA,
  REVERT_RESPONSE_SCHEMA,
  STAGE_CONTENT_RESPONSE_SCHEMA,
  START_RESPONSE_SCHEMA,
  VERIFY_BEHAVIOR_RESPONSE_SCHEMA,
} from './sessionClientSchemas.js';
import type {
  RemoteHoplonSessionClient,
  RemoteHoplonSessionClientOptions,
} from './sessionClientTypes.js';

export type {
  RemoteHoplonSessionClient,
  RemoteHoplonSessionClientOptions,
} from './sessionClientTypes.js';

function sessionCorrelationId(
  req:
    | {
        sessionId?: string | undefined;
        correlationId?: string | undefined;
      }
    | undefined,
  fallback: string,
): string {
  return req?.sessionId ?? req?.correlationId ?? fallback;
}

export function createRemoteHoplonSessionClient(
  opts: RemoteHoplonSessionClientOptions,
): RemoteHoplonSessionClient {
  const resolved = resolveSessionClientOptions(opts);
  const dispatch = dispatchSessionRequest;
  return {
    start: (req, signal) =>
      dispatch('POST', 'start', req, StartSessionRequestSchema, START_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-start')),
    preflight: (req, signal) =>
      dispatch('POST', 'preflight', req, SessionRefSchema, PREFLIGHT_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-preflight')),
    createSnapshot: (req, signal) =>
      dispatch('POST', 'createSnapshot', req, SessionRefSchema, CREATE_SNAPSHOT_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-createSnapshot')),
    dryRun: (req, signal) =>
      dispatch('POST', 'dryRun', req, SessionDryRunRequestSchema, DRY_RUN_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-dryRun')),
    applyEdits: (req, signal) =>
      dispatch('POST', 'applyEdits', req, SessionApplyEditsRequestSchema, APPLY_EDITS_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-applyEdits')),
    stageContent: (req, signal) =>
      dispatch('POST', 'stageContent', req, SessionStageContentRequestSchema, STAGE_CONTENT_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-stageContent')),
    markEdited: (req, signal) =>
      dispatch('POST', 'markEdited', req, SessionMarkEditedRequestSchema, MARK_EDITED_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-markEdited')),
    audit: (req, signal) =>
      dispatch('POST', 'audit', req, SessionRefSchema, AUDIT_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-audit')),
    revert: (req, signal) =>
      dispatch('POST', 'revert', req, SessionRefSchema, REVERT_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-revert')),
    extractRollbackTemplate: (req, signal) =>
      dispatch('POST', 'extractRollbackTemplate', req, SessionExtractRollbackTemplateRequestSchema, EXTRACT_ROLLBACK_TEMPLATE_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-extractRollbackTemplate')),
    getRepairContext: (req, signal) =>
      dispatch('POST', 'getRepairContext', req, SessionRefSchema, GET_REPAIR_CONTEXT_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-getRepairContext')),
    verifyBehavior: (req, signal) =>
      dispatch('POST', 'verifyBehavior', req, SessionVerifyBehaviorRequestSchema, VERIFY_BEHAVIOR_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-verifyBehavior')),
    inspect: (req, signal) =>
      dispatch('POST', 'inspect', req, SessionRefSchema, InspectSessionResponseSchema, resolved, signal, sessionCorrelationId(req, 'session-inspect')),
    close: (req, signal) =>
      dispatch('POST', 'close', req, SessionRefSchema, CLOSE_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-close')),
    list: (signal) =>
      dispatch('GET', 'list', undefined, null, ListSessionsResponseSchema, resolved, signal, 'session-list'),
    quickEdit: (req, signal) =>
      dispatch('POST', 'quickEdit', req, SessionQuickEditRequestSchema, QuickEditResultDataSchema, resolved, signal, sessionCorrelationId(req, 'session-quickEdit')),
    getSnapshotEvidence: (req, signal) =>
      dispatch('POST', 'snapshotEvidence', req, SessionSnapshotEvidenceRequestSchema, GET_SNAPSHOT_EVIDENCE_RESPONSE_SCHEMA, resolved, signal, sessionCorrelationId(req, 'session-getSnapshotEvidence')),
  };
}
