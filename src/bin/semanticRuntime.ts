import * as fs from 'node:fs';
import * as path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';

import { createHashingTextEmbedding } from '../hoplon/adapters/embedding/hashing.js';
import { resolveLauncherWorkspace } from '../hoplon/launcher/config.js';
import type { LauncherWorkspaceInput } from '../hoplon/launcher/config.js';
import type { SemanticRuntimeAdapters } from '../hoplon/engine/factory.js';
import type {
  LexicalIndexAdapter,
  SemanticStorageProfileAdapter,
  VectorIndexAdapter,
} from '../hoplon/adapters/index.js';

const VECTOR_DIMENSION = 128;
const LOCAL_NATIVE_PACKAGE = 'packages/vector-store-sqlite-vec';

interface NativeSemanticIndex {
  describe(): Promise<unknown>;
  close(): Promise<void>;
}

interface NativeHoplonAdapters {
  readonly lexicalIndex: LexicalIndexAdapter;
  readonly vectorIndex: VectorIndexAdapter;
  readonly semanticStorageProfile: SemanticStorageProfileAdapter;
}

interface NativeRuntimeModule {
  createNodeSqliteVecSemanticIndex(options: {
    readonly databasePath: string;
    readonly vectorDimension: number;
  }): Promise<NativeSemanticIndex>;
  createNodeSqliteVecHoplonAdapters(
    index: NativeSemanticIndex,
  ): NativeHoplonAdapters;
}

export async function createLauncherSemanticRuntime(
  input: LauncherWorkspaceInput = {},
): Promise<SemanticRuntimeAdapters | undefined> {
  const native = await loadNativeRuntimeModule();
  if (native === null) return undefined;

  const workspace = resolveLauncherWorkspace(input);
  const databasePath = path.join(workspace.root, '.hoplon', 'semantic-index.sqlite');
  try {
    fs.mkdirSync(path.dirname(databasePath), { recursive: true });
  } catch {
    return undefined;
  }

  const nativeIndex = await native.createNodeSqliteVecSemanticIndex({
    databasePath,
    vectorDimension: VECTOR_DIMENSION,
  });
  const nativeAdapters = native.createNodeSqliteVecHoplonAdapters(nativeIndex);

  return {
    embedding: createHashingTextEmbedding({ dimensions: VECTOR_DIMENSION }),
    lexicalIndex: nativeAdapters.lexicalIndex,
    vectorIndex: nativeAdapters.vectorIndex,
    semanticStorageProfile: nativeAdapters.semanticStorageProfile,
  };
}

async function loadNativeRuntimeModule(): Promise<NativeRuntimeModule | null> {
  for (const specifier of nativeRuntimeModuleSpecifiers()) {
    try {
      const mod = await import(specifier);
      if (isNativeRuntimeModule(mod)) return mod;
    } catch {
      // Optional runtime package is absent or not built for this launch shape.
    }
  }
  return null;
}

function nativeRuntimeModuleSpecifiers(): string[] {
  const repoRoot = findRepoRoot();
  const localDist = path.join(repoRoot, LOCAL_NATIVE_PACKAGE, 'dist', 'index.js');
  const localSource = path.join(repoRoot, LOCAL_NATIVE_PACKAGE, 'src', 'index.ts');
  return [
    '@phalanx/hoplon-vector-store-sqlite-vec',
    pathToFileURL(localDist).href,
    pathToFileURL(localSource).href,
  ];
}

function findRepoRoot(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  const seen = new Set<string>();
  while (!seen.has(dir)) {
    seen.add(dir);
    if (isHoplonPackageRoot(dir)) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return process.cwd();
}

function isHoplonPackageRoot(dir: string): boolean {
  try {
    const pkg = JSON.parse(
      fs.readFileSync(path.join(dir, 'package.json'), 'utf8'),
    ) as { readonly name?: string };
    return pkg.name === '@phalanx/hoplon';
  } catch {
    return false;
  }
}

function isNativeRuntimeModule(value: unknown): value is NativeRuntimeModule {
  const candidate = value as Partial<NativeRuntimeModule> | null;
  return (
    typeof candidate?.createNodeSqliteVecSemanticIndex === 'function' &&
    typeof candidate.createNodeSqliteVecHoplonAdapters === 'function'
  );
}
