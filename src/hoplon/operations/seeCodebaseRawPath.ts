/** Raw-path execution for seeCodebase. */

import { isAbsolute, relative, resolve } from 'node:path';

import { ValidationError } from '../contracts/errors.js';
import {
  type SeeCodebaseError,
  type SeeCodebasePrimitiveId,
  type SeeCodebaseRequestValidated,
  type SeeCodebaseResult,
  type SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import { buildTokenTelemetry } from '../contracts/tokenTelemetry.js';
import type { SeeCodebaseDeps } from './seeCodebase.js';
import { readEditSlice } from './seeCodebaseEditSlice.js';
import { liveFsProvenance } from './seeCodebaseProvenance.js';
import { rawFileRead, rawTextSearch } from './seeCodebaseRaw.js';

export interface ExecuteRawPathResult {
  truncated: boolean;
  truncationReason?: string;
  targetErrors: SeeCodebaseError[];
}

export async function executeRawPath(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  targets: readonly SeeCodebaseTarget[],
  results: SeeCodebaseResult[],
  used: Set<SeeCodebasePrimitiveId>,
): Promise<ExecuteRawPathResult> {
  let truncated = false;
  let truncationReason: string | undefined;
  const targetErrors: SeeCodebaseError[] = [];
  const strictFilePolicy = request.engagement !== undefined;
  const strictFolder = normalizeStrictFolderForAdapter(
    request.engagement?.folder,
    deps.root,
  );
  const context: RawTargetContext = strictFolder !== undefined
    ? { strictFilePolicy, strictFolder }
    : { strictFilePolicy };

  for (const target of targets) {
    try {
      const outcome = await executeRawTarget(
        deps,
        request,
        target,
        context,
        results,
        used,
      );
      if (outcome.truncated) {
        truncated = true;
        truncationReason = outcome.truncationReason;
      }
    } catch (err) {
      const targetError = recoverableRawTargetError(err, target);
      if (targetError === undefined) throw err;
      targetErrors.push(targetError);
    }
  }

  return truncationReason !== undefined
    ? { truncated, truncationReason, targetErrors }
    : { truncated, targetErrors };
}

interface RawTargetContext {
  strictFilePolicy: boolean;
  strictFolder?: string;
}

async function executeRawTarget(
  deps: SeeCodebaseDeps,
  request: SeeCodebaseRequestValidated,
  target: SeeCodebaseTarget,
  context: RawTargetContext,
  results: SeeCodebaseResult[],
  used: Set<SeeCodebasePrimitiveId>,
): Promise<{ truncated: boolean; truncationReason?: string }> {
  if (target.kind === 'edit_slice') {
    const editSlice = await readEditSlice(deps.fs, target.path, {
      engineId: deps.engineId,
      correlationId: request.correlationId,
      root: deps.root,
      startLine: target.startLine,
      endLine: target.endLine,
      strictFilePolicy: context.strictFilePolicy,
      ...(context.strictFolder !== undefined ? { strictFolder: context.strictFolder } : {}),
    });
    results.push({
      kind: 'edit_slice',
      path: editSlice.path,
      startLine: editSlice.startLine,
      endLine: editSlice.endLine,
      byteRange: [editSlice.byteRange[0], editSlice.byteRange[1]],
      content: editSlice.content,
      omitted: false,
      safeToEditFrom: true,
      encoding: 'utf-8',
      newlineStyle: editSlice.newlineStyle,
      anchors: editSlice.anchors,
      readProvenance: liveFsProvenance(deps.root, editSlice.path),
      tokenTelemetry: buildTokenTelemetry({
        rawBytesConsidered: editSlice.originalBytes,
        returnedBytes: editSlice.returnedBytes,
      }),
    });
    used.add('editSliceRead');
    return { truncated: false };
  }

  if (target.kind === 'file') {
    const read = await rawFileRead(deps.fs, target.path, {
      engineId: deps.engineId,
      correlationId: request.correlationId,
      root: deps.root,
      strictFilePolicy: context.strictFilePolicy,
      ...(context.strictFolder !== undefined ? { strictFolder: context.strictFolder } : {}),
      ...(typeof request.maxBytes === 'number' ? { maxBytes: request.maxBytes } : {}),
    });
    results.push({
      kind: 'raw_file',
      path: read.path,
      bytes: read.bytes,
      originalBytes: read.originalBytes,
      content: read.content,
      truncated: read.truncated,
      readProvenance: liveFsProvenance(deps.root, read.path),
      tokenTelemetry: buildTokenTelemetry({
        rawBytesConsidered: read.originalBytes,
        returnedBytes: read.bytes,
        notes: read.truncated ? ['caller maxBytes limited returned raw content'] : [],
      }),
    });
    used.add('rawFileRead');
    return read.truncated
      ? { truncated: true, truncationReason: 'maxBytes' }
      : { truncated: false };
  }

  if (target.kind === 'project' || target.kind === 'ast_node') {
    return { truncated: false };
  }

  const regexText =
    target.kind === 'pattern' ? target.regex : wordBoundaryRegex(target.name);
  let regex: RegExp;
  try {
    regex = new RegExp(regexText);
  } catch (err) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: request.correlationId,
        cause: err,
      },
      `see_codebase: pattern regex is invalid: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  const search = await rawTextSearch(deps.fs, {
    engineId: deps.engineId,
    correlationId: request.correlationId,
    root: deps.root,
    regex,
    ...(target.kind === 'pattern' && Array.isArray(target.scope) ? { scope: target.scope } : {}),
    ...(target.kind === 'symbol' && typeof target.file === 'string' ? { scope: [target.file] } : {}),
    ...(typeof request.maxResults === 'number' ? { maxResults: request.maxResults } : {}),
    maxFileBytes: deps.config.maxFileBytes,
    strictFilePolicy: context.strictFilePolicy,
    ...(context.strictFolder !== undefined ? { strictFolder: context.strictFolder } : {}),
  });
  results.push({
    kind: 'raw_search',
    regex: regexText,
    matches: search.matches,
    filesScanned: search.filesScanned,
    truncated: search.truncated,
    readProvenance: liveFsProvenance(deps.root),
  });
  used.add('rawTextSearch');
  return search.truncated
    ? { truncated: true, truncationReason: 'maxResults' }
    : { truncated: false };
}

function recoverableRawTargetError(
  err: unknown,
  target: SeeCodebaseTarget,
): SeeCodebaseError | undefined {
  const kind = typeof err === 'object' && err !== null
    ? (err as { kind?: unknown }).kind
    : undefined;
  if (kind !== 'path_not_found' && kind !== 'strict_file_policy') {
    return undefined;
  }
  const targetPath = targetPathFromError(err) ?? targetPathFromTarget(target);
  return {
    kind: kind === 'path_not_found' ? 'PATH_NOT_FOUND' : 'UNSUPPORTED_TARGET',
    message: err instanceof Error ? err.message : String(err),
    requestedPath: 'raw',
    ...(targetPath !== undefined ? { targetPath } : {}),
  };
}

function targetPathFromError(err: unknown): string | undefined {
  if (typeof err !== 'object' || err === null) return undefined;
  const path = (err as { targetPath?: unknown; path?: unknown }).targetPath
    ?? (err as { path?: unknown }).path;
  return typeof path === 'string' && path.length > 0 ? path : undefined;
}

function targetPathFromTarget(target: SeeCodebaseTarget): string | undefined {
  if (target.kind === 'file' || target.kind === 'edit_slice') return target.path;
  if (target.kind === 'ast_node') return target.file;
  if (target.kind === 'symbol') return target.file;
  if (target.kind === 'pattern' && target.scope?.length === 1) return target.scope[0];
  return undefined;
}

function wordBoundaryRegex(literal: string): string {
  const escaped = literal.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `\\b${escaped}\\b`;
}

function normalizeStrictFolderForAdapter(
  folder: string | undefined,
  root: string,
): string | undefined {
  if (folder === undefined || folder === '' || !isAbsolute(folder)) return folder;
  const fromRoot = relative(resolve(root), resolve(folder)).replace(/\\/g, '/');
  if (fromRoot === '') return '';
  if (fromRoot === '..' || fromRoot.startsWith('../') || isAbsolute(fromRoot)) {
    return folder;
  }
  return fromRoot;
}
