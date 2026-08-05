import type { SemanticOverlayRefreshResult } from '../../contracts/semanticSearch.js';
import type { VerifyBehaviorResult } from '../../contracts/verifyBehavior.js';
import type {
  InspectSessionResponse,
  ListSessionsResponse,
  QuickEditResultData,
  SessionApplyEditsRequest,
  SessionDryRunRequest,
  SessionExtractRollbackTemplateRequest,
  SessionMarkEditedRequest,
  SessionQuickEditRequest,
  SessionRef,
  SessionResponse,
  SessionSnapshotEvidenceRequest,
  SessionSnapshotEvidenceResult,
  SessionStageContentRequest,
  SessionVerifyBehaviorRequest,
  StartSessionRequest,
} from '../../session/transportContracts.js';
import type { StageContentResult } from '../../session/types.js';
import type { FetchFn } from './clientDispatch.js';

export interface RemoteHoplonSessionClientOptions {
  baseUrl: string;
  authToken?: string;
  fetchImpl?: FetchFn;
  engineId?: string;
}

export interface RemoteHoplonSessionClient {
  start(req: StartSessionRequest, signal?: AbortSignal): Promise<SessionResponse<{ engineId: string }>>;
  preflight(req: SessionRef, signal?: AbortSignal): Promise<SessionResponse<{ result: unknown }>>;
  createSnapshot(req: SessionRef, signal?: AbortSignal): Promise<SessionResponse<{ snapshotRef: unknown }>>;
  dryRun(req: SessionDryRunRequest, signal?: AbortSignal): Promise<SessionResponse<{ result: unknown }>>;
  applyEdits(req: SessionApplyEditsRequest, signal?: AbortSignal): Promise<SessionResponse<{
    changedFiles: readonly string[];
    bytesWritten: number;
    changeKindCounts: { full_file: number; patch: number; structural: number };
    overlayRefresh?: SemanticOverlayRefreshResult;
  }>>;
  stageContent(req: SessionStageContentRequest, signal?: AbortSignal): Promise<SessionResponse<StageContentResult>>;
  markEdited(req: SessionMarkEditedRequest, signal?: AbortSignal): Promise<SessionResponse<{
    changedFiles: readonly string[];
    overlayRefresh: SemanticOverlayRefreshResult;
  }>>;
  audit(req: SessionRef, signal?: AbortSignal): Promise<SessionResponse<{ result: unknown }>>;
  revert(req: SessionRef, signal?: AbortSignal): Promise<SessionResponse<{ result: unknown }>>;
  extractRollbackTemplate(req: SessionExtractRollbackTemplateRequest, signal?: AbortSignal): Promise<SessionResponse<{ template: unknown }>>;
  getRepairContext(req: SessionRef, signal?: AbortSignal): Promise<SessionResponse<{ repairContext: unknown }>>;
  verifyBehavior(req: SessionVerifyBehaviorRequest, signal?: AbortSignal): Promise<SessionResponse<{ verification: VerifyBehaviorResult }>>;
  inspect(req: SessionRef, signal?: AbortSignal): Promise<InspectSessionResponse>;
  close(req: SessionRef, signal?: AbortSignal): Promise<SessionResponse<{ closed: true }>>;
  list(signal?: AbortSignal): Promise<ListSessionsResponse>;
  quickEdit(req: SessionQuickEditRequest, signal?: AbortSignal): Promise<QuickEditResultData>;
  getSnapshotEvidence(req: SessionSnapshotEvidenceRequest, signal?: AbortSignal): Promise<SessionResponse<{ evidence: SessionSnapshotEvidenceResult }>>;
}
