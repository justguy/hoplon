import type { HoplonEmitter } from '../adapters/emitter.js';
import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import { AdapterError, ValidationError } from '../contracts/errors.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import { validateCorrelationId } from '../util/validators.js';
import { collectFiles } from './getRelevantTestsFileCollection.js';
import { classifySemanticSearchError } from './semanticSearchShared.js';

export type SemanticIndexBoundaryStatus = 'AVAILABLE' | 'DEGRADED' | 'EMPTY';

export type SemanticIndexBoundaryDegradationReason =
  | 'semantic_sidecar_excluded'
  | 'unsupported_symlink'
  | 'missing_file'
  | 'versioning_unavailable';

export interface SemanticIndexBoundaryDeps {
  readonly fs: HoplonFsAdapter;
  readonly versioning: VersioningAdapter;
  readonly emitter: HoplonEmitter;
  readonly engineId: string;
  readonly root: string;
}

export interface SemanticIndexBoundaryRequest {
  readonly projectId: string;
  readonly runId?: string;
  readonly correlationId: string;
  readonly fsRootIdentityHash: string;
  readonly fsRootRealpath?: string;
  readonly candidateFiles?: readonly string[];
}

export interface SemanticIndexPersistenceIdentity {
  readonly canonicalProjectRelativePath: string;
  readonly fsRootIdentityHash: string;
}

export interface SemanticIndexBoundaryDocument {
  readonly identity: SemanticIndexPersistenceIdentity;
  readonly bytes: Uint8Array;
  readonly worktreeState: 'clean' | 'dirty' | 'untracked' | 'unknown';
}

export interface SemanticIndexBoundaryResult {
  readonly status: SemanticIndexBoundaryStatus;
  readonly projectId: string;
  readonly correlationId: string;
  readonly fsRootIdentityHash: string;
  readonly headOid: string | null;
  readonly documents: readonly SemanticIndexBoundaryDocument[];
  readonly resultCount: number;
  readonly excludedCount: number;
  readonly degradationReasons: readonly SemanticIndexBoundaryDegradationReason[];
}

export async function buildSemanticIndexBoundaryDocuments(
  deps: SemanticIndexBoundaryDeps,
  req: SemanticIndexBoundaryRequest,
  signal?: AbortSignal,
): Promise<SemanticIndexBoundaryResult> {
  validateBoundaryRequest(deps, req);
  const start = Date.now();
  const emitBase = {
    engineId: deps.engineId,
    projectId: req.projectId,
    runId: req.runId,
    correlationId: req.correlationId,
  };
  deps.emitter.emit({ op: 'indexSemanticCorpus', phase: 'start', ...emitBase });

  try {
    if (signal?.aborted) throw abortError(signal);
    const versioning = await readVersioningState(deps, req.correlationId);
    const candidates = req.candidateFiles
      ? Array.from(req.candidateFiles)
      : await collectFiles(deps.fs, '.');
    const reasons = new Set<SemanticIndexBoundaryDegradationReason>();
    const documents: SemanticIndexBoundaryDocument[] = [];
    let excludedCount = 0;

    for (const candidate of candidates) {
      if (signal?.aborted) throw abortError(signal);
      const canonicalProjectRelativePath = canonicalSemanticIndexCandidatePath(
        deps,
        req,
        candidate,
      );
      if (isHardSemanticSidecarPath(canonicalProjectRelativePath)) {
        excludedCount += 1;
        reasons.add('semantic_sidecar_excluded');
        continue;
      }

      const stat = await safeStat(deps.fs, canonicalProjectRelativePath);
      if (stat.kind === 'unsupported_symlink') {
        reasons.add('unsupported_symlink');
        continue;
      }
      if (stat.kind === 'missing') {
        reasons.add('missing_file');
        continue;
      }
      if (!stat.value.isFile) continue;

      const bytes = await deps.fs.read(canonicalProjectRelativePath);
      documents.push({
        identity: {
          canonicalProjectRelativePath,
          fsRootIdentityHash: req.fsRootIdentityHash,
        },
        bytes,
        worktreeState: worktreeStateFor(
          canonicalProjectRelativePath,
          versioning.dirtyPaths,
        ),
      });
    }

    if (versioning.unavailable) reasons.add('versioning_unavailable');
    const status =
      documents.length === 0 ? 'EMPTY' : reasons.size > 0 ? 'DEGRADED' : 'AVAILABLE';
    const result: SemanticIndexBoundaryResult = {
      status,
      projectId: req.projectId,
      correlationId: req.correlationId,
      fsRootIdentityHash: req.fsRootIdentityHash,
      headOid: versioning.headOid,
      documents,
      resultCount: documents.length,
      excludedCount,
      degradationReasons: Array.from(reasons).sort(),
    };

    deps.emitter.emit({
      op: 'indexSemanticCorpus',
      phase: 'end',
      ...emitBase,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });
    return result;
  } catch (err) {
    deps.emitter.emit({
      op: 'indexSemanticCorpus',
      phase: 'error',
      ...emitBase,
      durationMs: Date.now() - start,
      ...classifySemanticSearchError(err, 'indexing_failed'),
    });
    throw err;
  }
}

function validateBoundaryRequest(
  deps: SemanticIndexBoundaryDeps,
  req: SemanticIndexBoundaryRequest,
): void {
  validateCorrelationId(req.correlationId);
  if (req.projectId.length === 0 || req.fsRootIdentityHash.length === 0) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: deps.engineId,
        correlationId: req.correlationId,
      },
      'Semantic index boundary request requires projectId and fsRootIdentityHash',
    );
  }
}

export function canonicalSemanticIndexCandidatePath(
  deps: SemanticIndexBoundaryDeps,
  req: SemanticIndexBoundaryRequest,
  inputPath: string,
): string {
  const normalized = inputPath
    .replace(/\\/g, '/')
    .replace(/^\.\//, '')
    .replace(/\/+$/g, '');
  if (normalized.length === 0 || normalized === '.') {
    throw new ValidationError(
      {
        kind: 'invalid_path',
        engineId: deps.engineId,
        correlationId: req.correlationId,
        cause: { path: inputPath },
      },
      'Semantic index candidate path must name a file',
    );
  }
  if (
    inputPath.startsWith('/') ||
    /^[A-Za-z]:[/\\]/.test(inputPath) ||
    normalized.split('/').includes('..')
  ) {
    throw new ValidationError(
      {
        kind: 'path_traversal',
        engineId: deps.engineId,
        correlationId: req.correlationId,
        cause: { path: inputPath },
      },
      `Semantic index candidate path escapes project root: '${inputPath}'`,
    );
  }
  canonicalizePath({
    path: normalized,
    root: deps.root,
    engineId: deps.engineId,
    correlationId: req.correlationId,
  });
  return normalized;
}

export function isHardSemanticSidecarPath(path: string): boolean {
  return path === '.hoplon' || path.startsWith('.hoplon/');
}

async function safeStat(
  fs: HoplonFsAdapter,
  path: string,
): Promise<
  | { readonly kind: 'ok'; readonly value: { exists: boolean; isFile: boolean; size: number } }
  | { readonly kind: 'missing' }
  | { readonly kind: 'unsupported_symlink' }
> {
  try {
    const value = await fs.stat(path);
    return value.exists ? { kind: 'ok', value } : { kind: 'missing' };
  } catch (err) {
    if (isPathTraversalAdapterError(err)) return { kind: 'unsupported_symlink' };
    throw err;
  }
}

function isPathTraversalAdapterError(err: unknown): boolean {
  return (
    err instanceof AdapterError &&
    err.cause instanceof ValidationError &&
    err.cause.kind === 'path_traversal'
  );
}

async function readVersioningState(
  deps: SemanticIndexBoundaryDeps,
  correlationId: string,
): Promise<{
  readonly headOid: string | null;
  readonly dirtyPaths: ReadonlySet<string>;
  readonly unavailable: boolean;
}> {
  try {
    const [headOid, matrix] = await Promise.all([
      deps.versioning.resolveRef(deps.root, 'HEAD'),
      deps.versioning.statusMatrix(deps.root),
    ]);
    const dirtyPaths = new Set<string>();
    for (const [path, head, workdir, stage] of matrix) {
      if (head !== workdir || workdir !== stage) dirtyPaths.add(path);
    }
    return { headOid, dirtyPaths, unavailable: false };
  } catch (err) {
    if (err instanceof AdapterError) {
      return { headOid: null, dirtyPaths: new Set(), unavailable: true };
    }
    throw new AdapterError(
      {
        kind: 'git_read_failed',
        engineId: deps.engineId,
        correlationId,
        cause: err,
      },
      'Failed to read semantic index versioning state',
    );
  }
}

function worktreeStateFor(
  canonicalProjectRelativePath: string,
  dirtyPaths: ReadonlySet<string>,
): SemanticIndexBoundaryDocument['worktreeState'] {
  return dirtyPaths.has(canonicalProjectRelativePath) ? 'dirty' : 'clean';
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}
