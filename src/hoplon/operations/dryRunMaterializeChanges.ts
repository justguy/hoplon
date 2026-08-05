import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { VersioningAdapter } from '../adapters/versioning.js';
import { AdapterError } from '../contracts/errors.js';
import type { DryRunRequest } from '../contracts/requests.js';
import type { AuditViolation } from '../contracts/audit.js';
import {
  ProposedChangeResolutionError,
  resolveProposedChange,
} from '../util/resolveProposedChange.js';

export interface MaterializedDryRunChange {
  file: string;
  content: string;
}

export interface MaterializeDryRunChangesOptions {
  changes: ReadonlyArray<DryRunRequest['proposedChanges'][number]>;
  versioning: VersioningAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  gitRepoDir: string;
  gitRef: string | null;
  signal?: AbortSignal | undefined;
}

export async function materializeDryRunChanges(
  opts: MaterializeDryRunChangesOptions,
): Promise<{
  resolvedChanges: MaterializedDryRunChange[];
  resolutionViolations: AuditViolation[];
}> {
  const { changes, versioning, codeIntelligence, gitRepoDir, gitRef, signal } = opts;
  const intermediates = new Map<string, Uint8Array | null>();
  const failedFiles = new Set<string>();
  const fileOrder: string[] = [];
  const resolutionViolations: AuditViolation[] = [];

  for (const change of changes) {
    if (signal?.aborted) throw abortError(signal);
    if (failedFiles.has(change.file)) continue;

    if (!intermediates.has(change.file)) {
      intermediates.set(
        change.file,
        await loadBaselineBytes(versioning, gitRepoDir, gitRef, change.file),
      );
      fileOrder.push(change.file);
    }

    try {
      const resolved = await resolveProposedChange(change, {
        currentBytes: intermediates.get(change.file) ?? null,
        codeIntelligence,
        signal,
      });
      intermediates.set(change.file, resolved.bytes);
    } catch (err) {
      const violation = classifyMaterializationError(err, change.file);
      if (violation === undefined) {
        throw err;
      }
      if (violation === null) throw err;
      failedFiles.add(change.file);
      resolutionViolations.push(violation);
    }
  }
  if (signal?.aborted) throw abortError(signal);

  const decoder = new TextDecoder('utf-8', { fatal: false });
  const resolvedChanges = fileOrder
    .filter((file) => !failedFiles.has(file))
    .map((file) => ({
      file,
      content: decoder.decode(intermediates.get(file) ?? new Uint8Array()),
    }));

  return { resolvedChanges, resolutionViolations };
}

async function loadBaselineBytes(
  versioning: VersioningAdapter,
  gitRepoDir: string,
  gitRef: string | null,
  file: string,
): Promise<Uint8Array> {
  if (gitRef === null) return new Uint8Array(0);
  try {
    return await versioning.readBlob(gitRepoDir, gitRef, file);
  } catch (err) {
    if (isBlobMissingAtRef(err, file)) {
      return new Uint8Array(0);
    }
    throw err;
  }
}

function classifyMaterializationError(
  err: unknown,
  file: string,
): AuditViolation | null | undefined {
  if (err instanceof ProposedChangeResolutionError) {
    return {
      kind: 'parse_failure',
      path: file,
      parseError: err.kind,
      nodeKind: null,
      message: `Could not materialize ${file}: ${err.detail}.`,
      correction: `Fix the proposed change for ${file} so Hoplon can deterministically materialize it before retrying.`,
    };
  }
  if (isAbortError(err)) return null;
  if (err instanceof AdapterError && err.kind === 'parser_init_failed') {
    const cause = err.cause as Record<string, unknown> | null | undefined;
    const parseError =
      cause != null && typeof cause.reason === 'string'
        ? cause.reason
        : err.message;
    return {
      kind: 'parse_failure',
      path: file,
      parseError,
      nodeKind: null,
      message: `Could not materialize ${file}: ${parseError}.`,
      correction: `Fix the proposed change for ${file} so Hoplon can deterministically materialize it before retrying.`,
    };
  }
  return undefined;
}

function isBlobMissingAtRef(err: unknown, file: string): boolean {
  if (!(err instanceof AdapterError) || err.kind !== 'git_read_failed') {
    return false;
  }
  const cause = err.cause as
    | { code?: unknown; name?: unknown; data?: { what?: unknown } }
    | null
    | undefined;
  if (cause?.code !== 'NotFoundError' && cause?.name !== 'NotFoundError') {
    return false;
  }
  const what = cause?.data?.what;
  return typeof what === 'string' && what.includes(`:${file}"`);
}

function isAbortError(err: unknown): boolean {
  return err instanceof DOMException && err.name === 'AbortError';
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('This operation was aborted', 'AbortError');
}
