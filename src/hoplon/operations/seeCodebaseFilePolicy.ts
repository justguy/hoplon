import type { HoplonFsAdapter } from '../adapters/fs.js';

export type SeeCodebasePathClass =
  | 'js_ts_code'
  | 'other_code'
  | 'package_manifest'
  | 'typescript_config'
  | 'test_fixture'
  | 'prompt_or_doc'
  | 'generated_report'
  | 'env_file'
  | 'log_file'
  | 'binary_file'
  | 'unsupported_text';

export interface SeeCodebasePathClassification {
  className: SeeCodebasePathClass;
  supportedInStrict: boolean;
  reason: string;
}

export class SeeCodebaseFilePolicyError extends Error {
  readonly kind = 'strict_file_policy';
  readonly path: string;
  readonly className: SeeCodebasePathClass;

  constructor(path: string, classification: SeeCodebasePathClassification) {
    super(
      `strict see_codebase cannot read requested file class: ${classification.reason}`,
    );
    this.name = 'SeeCodebaseFilePolicyError';
    this.path = path;
    this.className = classification.className;
  }
}

const JS_TS_EXTENSIONS = new Set(['.js', '.mjs', '.cjs', '.jsx', '.ts', '.tsx']);

const OTHER_CODE_EXTENSIONS = new Set([
  '.py', '.go', '.rs', '.java', '.kt', '.kts', '.rb', '.php',
  '.c', '.h', '.cc', '.cpp', '.hpp', '.cs', '.swift', '.scala',
  '.clj', '.ex', '.exs', '.erl', '.hrl', '.lua', '.pl', '.pm',
  '.dart', '.vue', '.svelte', '.css', '.scss', '.sass', '.less',
  '.html', '.xml', '.sql', '.sh', '.bash', '.zsh', '.fish', '.ps1',
]);

const FIXTURE_TEXT_EXTENSIONS = new Set([
  '.json', '.jsonc', '.yaml', '.yml', '.toml',
  '.txt', '.md', '.xml', '.csv',
]);

const BINARY_EXTENSIONS = new Set([
  '.png', '.jpg', '.jpeg', '.gif', '.webp', '.ico', '.pdf',
  '.zip', '.gz', '.tgz', '.tar', '.sqlite', '.sqlite3',
  '.db', '.wasm', '.class', '.jar', '.bin', '.lockb',
]);

const PACKAGE_MANIFESTS = new Set([
  'package.json', 'package-lock.json', 'npm-shrinkwrap.json',
  'pnpm-lock.yaml', 'yarn.lock', 'bun.lock', 'cargo.toml',
  'cargo.lock', 'pyproject.toml', 'poetry.lock', 'go.mod', 'go.sum',
]);

export function isJsTsPath(path: string): boolean {
  return JS_TS_EXTENSIONS.has(extensionOf(path));
}

export function classifySeeCodebasePath(
  path: string,
): SeeCodebasePathClassification {
  const normalized = path.replace(/\\/g, '/');
  const parts = normalized.split('/').filter((part) => part.length > 0);
  const basename = (parts.at(-1) ?? normalized).toLowerCase();
  const ext = extensionOf(normalized);

  if (isEnvPath(basename)) {
    return unsupported('env_file', 'environment files are not strict-agent readable');
  }
  if (isLogPath(parts, ext)) {
    return unsupported('log_file', 'log files are not strict-agent readable');
  }
  if (BINARY_EXTENSIONS.has(ext)) {
    return unsupported('binary_file', 'binary files are not strict-agent readable');
  }
  if (JS_TS_EXTENSIONS.has(ext)) {
    return supported('js_ts_code', 'JS/TS source is structurally supported');
  }
  if (PACKAGE_MANIFESTS.has(basename) || isRequirementsFile(basename)) {
    return supported('package_manifest', 'package manifests are code-adjacent text');
  }
  if (/^(tsconfig|jsconfig)(\..*)?\.json$/u.test(basename)) {
    return supported('typescript_config', 'TypeScript configs are code-adjacent text');
  }
  if (isGeneratedReport(parts, basename, ext)) {
    return supported('generated_report', 'generated reports are code-adjacent text');
  }
  if (isPromptOrDoc(parts, basename, ext)) {
    return supported('prompt_or_doc', 'prompt/source docs are code-adjacent text');
  }
  if (isFixture(parts, ext)) {
    return supported('test_fixture', 'test fixtures are code-adjacent text');
  }
  if (OTHER_CODE_EXTENSIONS.has(ext)) {
    return supported('other_code', 'non-JS source is code text');
  }
  return unsupported('unsupported_text', 'file class is not approved for strict-agent reads');
}

export function isStrictReadablePath(path: string): boolean {
  return classifySeeCodebasePath(path).supportedInStrict;
}

export async function assertStrictReadableFile(
  fs: HoplonFsAdapter,
  path: string,
): Promise<void> {
  assertStrictPathClass(path);
  const bytes = await fs.read(path);
  assertStrictReadableBytes(path, bytes);
}

export function assertStrictPathClass(path: string): void {
  const classification = classifySeeCodebasePath(path);
  if (!classification.supportedInStrict) {
    throw new SeeCodebaseFilePolicyError(path, classification);
  }
}

export function assertStrictPathWithinFolder(path: string, folder: string): void {
  if (folder === '') return;
  const normalizedPath = trimSlashes(path);
  const normalizedFolder = trimSlashes(folder);
  if (
    normalizedPath !== normalizedFolder &&
    !normalizedPath.startsWith(`${normalizedFolder}/`)
  ) {
    throw new SeeCodebaseFilePolicyError(
      path,
      unsupported(
        'unsupported_text',
        'target path is outside the strict engagement folder',
      ),
    );
  }
}

export function assertStrictReadableBytes(
  path: string,
  bytes: Uint8Array,
): void {
  if (hasBinaryContent(bytes)) {
    throw new SeeCodebaseFilePolicyError(
      path,
      unsupported('binary_file', 'binary content is not strict-agent readable'),
    );
  }
  if (!isUtf8Text(bytes)) {
    throw new SeeCodebaseFilePolicyError(
      path,
      unsupported(
        'unsupported_text',
        'invalid UTF-8 text is not strict-agent readable',
      ),
    );
  }
}

export function hasBinaryContent(bytes: Uint8Array): boolean {
  const head = bytes.subarray(0, Math.min(bytes.length, 1024));
  for (let i = 0; i < head.length; i += 1) {
    if (head[i] === 0) return true;
  }
  return false;
}

function isUtf8Text(bytes: Uint8Array): boolean {
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
    return true;
  } catch {
    return false;
  }
}

function supported(
  className: SeeCodebasePathClass,
  reason: string,
): SeeCodebasePathClassification {
  return { className, supportedInStrict: true, reason };
}

function unsupported(
  className: SeeCodebasePathClass,
  reason: string,
): SeeCodebasePathClassification {
  return { className, supportedInStrict: false, reason };
}

function extensionOf(path: string): string {
  const slash = path.lastIndexOf('/');
  const dot = path.lastIndexOf('.');
  return dot > slash ? path.slice(dot).toLowerCase() : '';
}

function trimSlashes(path: string): string {
  return path.replace(/\\/g, '/').replace(/^\/+|\/+$/gu, '');
}

function isEnvPath(basename: string): boolean {
  return (
    basename === '.env' ||
    basename === '.envrc' ||
    basename.startsWith('.env.') ||
    basename.endsWith('.env') ||
    basename.includes('.env.')
  );
}

function isLogPath(
  parts: readonly string[],
  ext: string,
): boolean {
  return ext === '.log' || parts.some((part) => part.toLowerCase() === 'logs');
}

function isRequirementsFile(basename: string): boolean {
  return /^requirements([-.].*)?\.txt$/u.test(basename);
}

function isGeneratedReport(
  parts: readonly string[],
  basename: string,
  ext: string,
): boolean {
  const inReportDir = parts.some((part) => {
    const lower = part.toLowerCase();
    return lower === 'reports' || lower === 'report';
  });
  const reportName = basename.includes('_report.') || basename.includes('.report.');
  return (inReportDir || reportName) && FIXTURE_TEXT_EXTENSIONS.has(ext);
}

function isPromptOrDoc(
  parts: readonly string[],
  basename: string,
  ext: string,
): boolean {
  const inDocsOrPrompts = parts.some((part) => {
    const lower = part.toLowerCase();
    return lower === 'docs' || lower === 'prompts' || lower === 'prompt';
  });
  const namedDoc = /^(readme|agents|claude|contributing|changelog|license)(\..*)?$/u
    .test(basename);
  const projectSourceDoc =
    /(^|[_-])(architecture|vision|roadmap|plan|prompt)([_.-]|$)/u.test(basename);
  const promptDoc = basename.includes('.prompt.');
  return (
    ((ext === '.md' || ext === '.mdx' || ext === '.rst' || ext === '.adoc') &&
      (inDocsOrPrompts || namedDoc || projectSourceDoc || promptDoc)) ||
    (inDocsOrPrompts && basename.endsWith('.txt'))
  );
}

function isFixture(parts: readonly string[], ext: string): boolean {
  return (
    FIXTURE_TEXT_EXTENSIONS.has(ext) &&
    parts.some((part) => {
      const lower = part.toLowerCase();
      return (
        lower === 'fixtures' ||
        lower === '__fixtures__' ||
        lower === 'testdata'
      );
    })
  );
}
