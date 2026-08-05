import type { ProposedChange } from '../contracts/requests.js';
import type {
  SemanticCorpusDocument,
  SemanticDegradationReason,
  SemanticOverlayRefreshResult,
} from '../contracts/semanticSearch.js';
import type { SessionRuntime } from './sessionRuntime.js';

interface RefreshOverlayArgs {
  mode: 'dry_run' | 'written_bytes';
  inputSource: 'proposed_changes' | 'written_bytes' | 'live_files' | 'failure_mask';
  touchedFiles: readonly string[];
  documents: readonly SemanticCorpusDocument[];
  status?: 'AVAILABLE' | 'DEGRADED' | 'UNAVAILABLE' | 'EMPTY';
  degradationReasons?: readonly SemanticDegradationReason[];
}

export async function refreshOverlay(
  runtime: SessionRuntime,
  args: RefreshOverlayArgs,
): Promise<SemanticOverlayRefreshResult> {
  const identity = {
    correlationId: runtime.correlationId,
    projectId: runtime.manifest.projectId,
    ...(runtime.worktreeId !== null ? { worktreeId: runtime.worktreeId } : {}),
    sessionId: runtime.sessionId,
  };
  if (typeof runtime.engine.refreshSemanticOverlay !== 'function') {
    return {
      ...identity,
      status: 'UNAVAILABLE',
      mode: args.mode,
      inputSource: args.inputSource,
      overlayGeneration: 0,
      published: false,
      retainedPreviousOverlay: false,
      touchedFileCount: args.touchedFiles.length,
      documentCount: 0,
      lexicalCount: 0,
      vectorCount: 0,
      maskCount: new Set(args.touchedFiles).size,
      degradationReasons: ['overlay_unavailable_process_local_store'],
    };
  }
  try {
    return await runtime.engine.refreshSemanticOverlay({
      ...identity,
      mode: args.mode,
      inputSource: args.inputSource,
      touchedFiles: [...args.touchedFiles],
      documents: [...args.documents],
      ...(args.status !== undefined ? { status: args.status } : {}),
      ...(args.degradationReasons !== undefined
        ? { degradationReasons: [...args.degradationReasons] }
        : {}),
    });
  } catch {
    return {
      ...identity,
      status: 'UNAVAILABLE',
      mode: args.mode,
      inputSource: 'failure_mask',
      overlayGeneration: 0,
      published: false,
      retainedPreviousOverlay: false,
      touchedFileCount: args.touchedFiles.length,
      documentCount: 0,
      lexicalCount: 0,
      vectorCount: 0,
      maskCount: new Set(args.touchedFiles).size,
      degradationReasons: ['overlay_refresh_failed'],
    };
  }
}

export async function clearOverlay(runtime: SessionRuntime): Promise<void> {
  if (typeof runtime.engine.clearSemanticOverlay !== 'function') return;
  await runtime.engine.clearSemanticOverlay({
    correlationId: runtime.correlationId,
    projectId: runtime.manifest.projectId,
    ...(runtime.worktreeId !== null ? { worktreeId: runtime.worktreeId } : {}),
    sessionId: runtime.sessionId,
  });
}

export function touchedFilesFromChanges(
  changes: readonly ProposedChange[],
): readonly string[] {
  return [...new Set(changes.map((change) => change.file))].sort();
}

export function documentsFromProposedChanges(
  runtime: SessionRuntime,
  changes: readonly ProposedChange[],
  mode: 'dry_run' | 'written_bytes',
): readonly SemanticCorpusDocument[] {
  const docs: SemanticCorpusDocument[] = [];
  for (const file of touchedFilesFromChanges(changes)) {
    const lastContentChange = [...changes]
      .reverse()
      .find((change) => change.file === file && 'content' in change);
    if (
      lastContentChange === undefined ||
      !('content' in lastContentChange) ||
      typeof lastContentChange.content !== 'string'
    ) {
      continue;
    }
    docs.push(documentFromText(runtime, file, lastContentChange.content, mode));
  }
  return docs;
}

export async function documentsFromLiveFiles(
  runtime: SessionRuntime,
  files: readonly string[],
  mode: 'dry_run' | 'written_bytes',
): Promise<readonly SemanticCorpusDocument[]> {
  if (runtime.fs === null) return [];
  const docs: SemanticCorpusDocument[] = [];
  for (const file of [...new Set(files)].sort()) {
    try {
      const stat = await runtime.fs.stat(file);
      if (!stat.exists || !stat.isFile) continue;
      const content = new TextDecoder('utf-8', { fatal: true }).decode(
        await runtime.fs.read(file),
      );
      if (content.length > 0) {
        docs.push(documentFromText(runtime, file, content, mode));
      }
    } catch {
      // Touched-file masks still hide stale rows when advisory reads fail.
    }
  }
  return docs;
}

function documentFromText(
  runtime: SessionRuntime,
  file: string,
  text: string,
  mode: 'dry_run' | 'written_bytes',
): SemanticCorpusDocument {
  return {
    id: `${runtime.sessionId}:${mode}:${file}`,
    text,
    documentTextHash: `${mode}:${file}:${new TextEncoder().encode(text).byteLength}`,
    metadata: {
      projectId: runtime.manifest.projectId,
      sessionId: runtime.sessionId,
      path: file,
      mode,
    },
  };
}
