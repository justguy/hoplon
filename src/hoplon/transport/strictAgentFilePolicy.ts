import {
  assertStrictPathWithinFolder,
  classifySeeCodebasePath,
  SeeCodebaseFilePolicyError,
} from '../operations/seeCodebaseFilePolicy.js';

/**
 * hcr-004 finding 4 — compare session-scoped write targets (manifest entry
 * paths, applyEdits / markEdited file paths) against the verified strict
 * engagement folder. Paths outside the authorized folder are denied with
 * the same typed strict-file-policy error the read-side checks use. A ''
 * folder (project-root engagement) authorizes every project-relative path.
 */
export function assertStrictSessionPathsWithinFolder(
  paths: readonly string[],
  folder: string,
): void {
  for (const path of paths) {
    assertStrictPathWithinFolder(path, folder);
  }
}

export function assertStrictAgentFilePolicy(method: string, body: unknown): void {
  if (typeof body !== 'object' || body === null) return;
  const folder = strictFolderFromBody(body);
  const raw = body as Record<string, unknown>;
  if (method === 'findSyntaxNode') {
    const file = stringField(raw, 'file');
    if (file) assertSupportedPath(file, folder);
    return;
  }
  if (method === 'searchSymbols') {
    assertSearchSymbolsScope(raw, folder);
    return;
  }
  if (method === 'describeProject' || method === 'getRelevantTests') {
    assertRootScopeForWholeProjectScan(folder);
    return;
  }
  // Critical-review fix (strict semantic bypass): corpus-wide semantic ops
  // are whole-project scans; overlay refresh carries explicit file paths.
  if (
    method === 'semanticSearch' ||
    method === 'indexSemanticCorpus' ||
    method === 'clearSemanticOverlay'
  ) {
    assertRootScopeForWholeProjectScan(folder);
    return;
  }
  if (method === 'refreshSemanticOverlay') {
    assertSemanticOverlayTouchedFiles(raw, folder);
    return;
  }
  if (method === 'seeCodebase') assertSeeCodebaseTargets(raw, folder);
}

/**
 * Overlay refresh feeds file-derived rows into semantic retrieval. Each
 * touched file must sit inside the engagement folder and stay out of the
 * secret-bearing classes (env/log/binary) — same rule as pattern-search
 * scopes, since overlay rows are corpus material rather than raw reads.
 */
function assertSemanticOverlayTouchedFiles(
  raw: Record<string, unknown>,
  folder: string,
): void {
  const touched = raw['touchedFiles'];
  if (!Array.isArray(touched)) return;
  for (const file of touched) {
    if (typeof file === 'string') assertPatternScope(file, folder);
  }
}

function assertSeeCodebaseTargets(raw: Record<string, unknown>, folder: string): void {
  const targets = raw['targets'];
  if (!Array.isArray(targets)) return;
  for (const target of targets) assertTargetPath(target, folder);
}

function assertSearchSymbolsScope(raw: Record<string, unknown>, folder: string): void {
  const files = raw['files'];
  if (!Array.isArray(files)) {
    assertRootScopeForWholeProjectScan(folder);
    return;
  }
  for (const file of files) {
    if (typeof file === 'string') assertSupportedPath(file, folder);
  }
}

function assertTargetPath(target: unknown, folder: string): void {
  if (typeof target !== 'object' || target === null) return;
  const raw = target as Record<string, unknown>;
  if (raw['kind'] === 'file' && typeof raw['path'] === 'string') {
    assertSupportedPath(raw['path'], folder);
    return;
  }
  if (raw['kind'] === 'ast_node' && typeof raw['file'] === 'string') {
    assertSupportedPath(raw['file'], folder);
    return;
  }
  if (raw['kind'] === 'symbol') {
    if (typeof raw['file'] === 'string') {
      assertSupportedPath(raw['file'], folder);
      return;
    }
    assertRootScopeForWholeProjectScan(folder);
    return;
  }
  if (raw['kind'] === 'project') {
    assertRootScopeForWholeProjectScan(folder);
    return;
  }
  if (raw['kind'] === 'pattern') assertPatternTarget(raw, folder);
}

function assertPatternTarget(raw: Record<string, unknown>, folder: string): void {
  const scope = raw['scope'];
  if (!Array.isArray(scope)) {
    assertRootScopeForWholeProjectScan(folder);
    return;
  }
  for (const path of scope) {
    if (typeof path === 'string') assertPatternScope(path, folder);
  }
}

function assertSupportedPath(path: string, folder: string): void {
  assertStrictPathWithinFolder(path, folder);
  const classification = classifySeeCodebasePath(path);
  if (!classification.supportedInStrict) {
    throw new SeeCodebaseFilePolicyError(path, classification);
  }
}

function assertPatternScope(path: string, folder: string): void {
  assertStrictPathWithinFolder(path, folder);
  const classification = classifySeeCodebasePath(path);
  if (
    classification.className === 'env_file' ||
    classification.className === 'log_file' ||
    classification.className === 'binary_file'
  ) {
    throw new SeeCodebaseFilePolicyError(path, classification);
  }
}

function assertRootScopeForWholeProjectScan(folder: string): void {
  if (folder === '') return;
  assertStrictPathWithinFolder('.', folder);
}

function strictFolderFromBody(body: unknown): string {
  if (typeof body !== 'object' || body === null) return '';
  const engagement = (body as { engagement?: unknown }).engagement;
  if (typeof engagement !== 'object' || engagement === null) return '';
  const folder = (engagement as { folder?: unknown }).folder;
  return typeof folder === 'string' ? folder : '';
}

function stringField(raw: Record<string, unknown>, key: string): string | null {
  const value = raw[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}
