import type {
  DraftManifestFile,
  DraftWritableManifestRequest,
  DraftWritableManifestResult,
  DraftWritableManifestTarget,
} from '../contracts/writableManifestDraft.js';
import type { ManifestEntry, ManifestScope } from '../contracts/manifest.js';

export function draftWritableManifest(
  request: DraftWritableManifestRequest,
): DraftWritableManifestResult {
  const writableEntries = entriesForTarget(request.target);
  const writableFiles = writableEntries.map((entry) => ({
    path: entry.path,
    scope: entry.scope,
    reason: reasonForTarget(request.target, entry.path),
  }));
  const readOnlyFiles = readOnlyForRequest(request, writableEntries);
  const manifest = {
    manifestSchemaVersion: 2 as const,
    projectId: request.projectId,
    runId: request.runId,
    correlationId: request.correlationId,
    entries: writableEntries,
  };
  return {
    status: 'draft_requires_confirmation',
    requiresConfirmation: true,
    manifest,
    writableFiles,
    readOnlyFiles,
    reasons: [
      'Draft was inferred from deterministic target fields only.',
      'Caller or host must accept the manifest before any write path may use it.',
    ],
  };
}

function entriesForTarget(target: DraftWritableManifestTarget): ManifestEntry[] {
  if (target.kind === 'file') {
    return [entry(target.path, { kind: 'whole_file' }, target.intent)];
  }
  if (target.kind === 'symbol') {
    return [entry(target.file, { kind: 'symbols', symbols: [target.symbol] }, target.intent)];
  }
  if (target.kind === 'ast_node') {
    return [
      entry(
        target.file,
        { kind: 'symbols', symbols: [target.symbolPath[target.symbolPath.length - 1]!] },
        target.intent,
      ),
    ];
  }
  return target.definedIn.map((definition) =>
    entry(definition.path, { kind: 'whole_file' }, target.intent),
  );
}

function entry(
  path: string,
  scope: ManifestScope,
  intent: ManifestEntry['intent'],
): ManifestEntry {
  return {
    path,
    scope,
    ...(intent !== undefined ? { intent } : {}),
  };
}

function readOnlyForRequest(
  request: DraftWritableManifestRequest,
  writableEntries: readonly ManifestEntry[],
): DraftManifestFile[] {
  const writable = new Set(writableEntries.map((entry) => normalize(entry.path)));
  return [...new Set(request.readOnlyFiles ?? [])]
    .filter((path) => !writable.has(normalize(path)))
    .sort()
    .map((path) => ({
      path,
      reason: 'Caller supplied deterministic read-only context.',
    }));
}

function reasonForTarget(
  target: DraftWritableManifestTarget,
  _path: string,
): string {
  if (target.kind === 'file') return 'Target file was requested as writable.';
  if (target.kind === 'symbol') return `Target symbol ${target.symbol} is defined in this file.`;
  if (target.kind === 'ast_node') {
    return `Target AST symbol path ${target.symbolPath.join('.')} is defined in this file.`;
  }
  return `${target.kind} subject ${target.id} is defined in this file.`;
}

function normalize(path: string): string {
  return path.replace(/\\/gu, '/').replace(/^\.\//u, '');
}
