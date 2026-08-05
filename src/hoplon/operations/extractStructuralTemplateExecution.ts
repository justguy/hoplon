import type { HoplonFsAdapter } from '../adapters/fs.js';
import { createMemFsAdapter } from '../adapters/fs/memfs.js';
import type { ExtractStructuralTemplateRequest } from '../contracts/structuralTemplate.js';
import type { StructuralTemplate } from '../contracts/structuralTemplate.js';
import type { TreeSitterQuery } from '../contracts/queryStructure.js';
import { AdapterError, SemanticError } from '../contracts/errors.js';
import type { ExtractStructuralTemplateDeps } from './extractStructuralTemplate.js';
import { queryStructure } from './queryStructure.js';
import type { QueryStructureDeps } from './queryStructure.js';
import { STD_QUERY_EXPORTS, STD_QUERY_IMPORTS } from './stdQueries.js';
import { assembleStructuralTemplate } from './structuralTemplateAssembly.js';
import {
  DEFAULT_TEMPLATE_QUERY_ID,
  STD_QUERY_TYPES,
} from './structuralTemplateQueries.js';

interface ProcessArgs {
  deps: ExtractStructuralTemplateDeps;
  validated: ExtractStructuralTemplateRequest;
  signal: AbortSignal | undefined;
}

export async function processStructuralTemplate({
  deps,
  validated,
  signal,
}: ProcessArgs): Promise<StructuralTemplate> {
  const {
    versioning,
    snapshotStore,
    codeIntelligence,
    emitter,
    engineId,
    root,
    config,
  } = deps;
  const {
    correlationId,
    runId,
    projectId,
    files,
    snapshotRefId,
  } = validated;
  let queryFs: HoplonFsAdapter;
  let queryRoot: string;
  let resolvedSnapshotRef: string | null = null;

  if (snapshotRefId !== undefined) {
    const record = await snapshotStore.get(snapshotRefId);
    if (!record || record.status !== 'committed') {
      throw new SemanticError(
        {
          kind: 'snapshot_missing',
          engineId,
          correlationId,
          cause: { snapshotRefId },
        },
        `extractStructuralTemplate: snapshot '${snapshotRefId}' not found or not committed`,
      );
    }

    resolvedSnapshotRef = snapshotRefId;
    const stagingFs = createMemFsAdapter();
    for (const relPath of files) {
      if (signal?.aborted) throw abortError(signal);
      let blobContent: Uint8Array;
      try {
        blobContent = await versioning.readBlob(
          config.gitRepoDir,
          record.gitRef!,
          relPath,
        );
      } catch (error) {
        if (
          error instanceof AdapterError &&
          error.kind === 'git_read_failed'
        ) {
          continue;
        }
        throw error;
      }
      await stagingFs.write(relPath, blobContent);
    }
    queryFs = stagingFs;
    queryRoot = '/';
  } else {
    queryFs = deps.fs;
    queryRoot = root;
  }

  const customQueries = validated.customQueries;
  const queriesToRun: TreeSitterQuery[] =
    customQueries && customQueries.length > 0
      ? customQueries
      : [...STD_QUERY_EXPORTS, ...STD_QUERY_IMPORTS, ...STD_QUERY_TYPES];
  const queryDeps: QueryStructureDeps = {
    fs: queryFs,
    codeIntelligence,
    emitter,
    engineId,
    root: queryRoot,
    config: {
      maxFileBytes: config.maxFileBytes,
      parseTimeoutMs: config.parseTimeoutMs,
    },
  };
  const queryResult = await queryStructure(
    queryDeps,
    {
      projectId,
      runId,
      correlationId,
      files,
      queries: queriesToRun,
      snapshotRefId: snapshotRefId ?? undefined,
    },
    signal,
  );
  return assembleStructuralTemplate(
    files,
    queryResult.matches,
    validated.queryId ?? DEFAULT_TEMPLATE_QUERY_ID,
    resolvedSnapshotRef,
  );
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  return new DOMException(
    typeof signal.reason === 'string' ? signal.reason : 'Operation aborted',
    'AbortError',
  );
}
