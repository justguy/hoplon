import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { HoplonEngine } from '../engine/types.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import type { LockProvider } from '../adapters/lock.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { TraceStore } from '../adapters/traceStore.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import type { TargetFirstScopedEditRequest } from '../contracts/targetFirstScopedEdit.js';
import type { TargetFirstScopedEditResult } from '../contracts/targetFirstScopedEdit.js';
import type { DraftWritableManifestTarget } from '../contracts/writableManifestDraft.js';
import { buildTokenTelemetry } from '../contracts/tokenTelemetry.js';
import { draftWritableManifest } from '../operations/writableManifestDraft.js';
import { readEditSlice } from '../operations/seeCodebaseEditSlice.js';
import { liveFsProvenance } from '../operations/seeCodebaseProvenance.js';
import { quickEdit } from './quickEdit.js';
import type { SessionStagingOptions } from './stagingStore.js';

export interface TargetFirstScopedEditOptions {
  engine: HoplonEngine;
  request: TargetFirstScopedEditRequest;
  root: string;
  fs?: HoplonFsAdapter;
  codeIntelligence?: CodeIntelligenceAdapter;
  behaviorTestRunner?: BehaviorTestRunnerAdapter;
  lockProvider?: LockProvider;
  staging?: SessionStagingOptions;
  traceStore?: TraceStore;
  versioning?: VersioningAdapter;
  snapshotStore?: SnapshotStore;
  gitRepoDir?: string;
  revertAllowlist?: readonly string[];
  projectRoot?: string;
  emitter?: HoplonEmitter;
  engineId?: string;
  engineVersion?: string;
  now?: () => number;
}

export async function targetFirstScopedEdit(
  opts: TargetFirstScopedEditOptions,
): Promise<TargetFirstScopedEditResult> {
  const request = opts.request;
  const manifestDraft = draftWritableManifest({
    projectId: request.projectId,
    runId: request.runId,
    correlationId: request.correlationId,
    target: request.target,
    ...(request.readOnlyFiles !== undefined
      ? { readOnlyFiles: request.readOnlyFiles }
      : {}),
  });
  const editSlice = await maybeReadEditSlice(opts);
  const proofPlan = buildProofPlan(request.apply === true);
  if (request.apply !== true) {
    return {
      status: 'preview',
      manifestDraft,
      ...(editSlice !== null ? { editSlice } : {}),
      proofPlan,
    };
  }
  const quickEditResult = await quickEdit({
    engine: opts.engine,
    manifest: request.acceptedManifest!,
    correlationId: request.correlationId,
    ...(request.sessionId !== undefined ? { sessionId: request.sessionId } : {}),
    ...(request.proposedChanges !== undefined
      ? { proposedChanges: request.proposedChanges }
      : {}),
    ...(request.revertOnBlock !== undefined
      ? { revertOnBlock: request.revertOnBlock }
      : {}),
    ...(request.extractRollbackTemplateOnBlock !== undefined
      ? { extractRollbackTemplateOnBlock: request.extractRollbackTemplateOnBlock }
      : {}),
    ...(opts.fs !== undefined ? { fs: opts.fs } : {}),
    ...(opts.codeIntelligence !== undefined
      ? { codeIntelligence: opts.codeIntelligence }
      : {}),
    ...(opts.behaviorTestRunner !== undefined
      ? { behaviorTestRunner: opts.behaviorTestRunner }
      : {}),
    ...(opts.lockProvider !== undefined ? { lockProvider: opts.lockProvider } : {}),
    ...(opts.staging !== undefined ? { staging: opts.staging } : {}),
    ...(opts.traceStore !== undefined ? { traceStore: opts.traceStore } : {}),
    ...(opts.versioning !== undefined ? { versioning: opts.versioning } : {}),
    ...(opts.snapshotStore !== undefined ? { snapshotStore: opts.snapshotStore } : {}),
    ...(opts.gitRepoDir !== undefined ? { gitRepoDir: opts.gitRepoDir } : {}),
    ...(opts.revertAllowlist !== undefined
      ? { revertAllowlist: opts.revertAllowlist }
      : {}),
    ...(opts.projectRoot !== undefined ? { projectRoot: opts.projectRoot } : {}),
    ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
    ...(opts.engineId !== undefined ? { engineId: opts.engineId } : {}),
    ...(opts.engineVersion !== undefined ? { engineVersion: opts.engineVersion } : {}),
    ...(opts.now !== undefined ? { now: opts.now } : {}),
  });
  return {
    status: 'applied',
    manifestDraft,
    ...(editSlice !== null ? { editSlice } : {}),
    proofPlan,
    quickEditResult,
  };
}

async function maybeReadEditSlice(
  opts: TargetFirstScopedEditOptions,
): Promise<TargetFirstScopedEditResult['editSlice'] | null> {
  if (opts.fs === undefined || opts.request.editSlice === undefined) return null;
  const path = opts.request.editSlice.path ?? targetPath(opts.request.target);
  if (path === null) return null;
  const result = await readEditSlice(opts.fs, path, {
    engineId: opts.engineId ?? 'local-0',
    correlationId: opts.request.correlationId,
    root: opts.root,
    startLine: opts.request.editSlice.startLine,
    endLine: opts.request.editSlice.endLine,
  });
  return {
    kind: 'edit_slice',
    path: result.path,
    startLine: result.startLine,
    endLine: result.endLine,
    byteRange: [result.byteRange[0], result.byteRange[1]],
    content: result.content,
    omitted: false,
    safeToEditFrom: true,
    encoding: 'utf-8',
    newlineStyle: result.newlineStyle,
    anchors: result.anchors,
    readProvenance: liveFsProvenance(opts.root, result.path),
    tokenTelemetry: buildTokenTelemetry({
      rawBytesConsidered: result.originalBytes,
      returnedBytes: result.returnedBytes,
    }),
  };
}

function targetPath(target: DraftWritableManifestTarget): string | null {
  if (target.kind === 'file') return target.path;
  if (target.kind === 'symbol' || target.kind === 'ast_node') return target.file;
  return target.definedIn[0]?.path ?? null;
}

function buildProofPlan(apply: boolean): TargetFirstScopedEditResult['proofPlan'] {
  if (!apply) {
    return {
      phases: [
        'identify_target',
        'read_exact_context',
        'draft_manifest',
        'await_manifest_confirmation',
        'dry_run',
        'review',
      ],
      notes: [
        'Preview mode does not write files and does not treat the draft manifest as authorization.',
      ],
    };
  }
  return {
    phases: [
      'identify_target',
      'read_exact_context',
      'draft_manifest',
      'preflight',
      'create_snapshot',
      'apply_edits',
      'audit',
      'review',
      'close',
    ],
    notes: [
      'Apply mode uses only the caller-supplied acceptedManifest.',
      'The quick-edit result carries the actual supervised session outcome.',
    ],
  };
}
