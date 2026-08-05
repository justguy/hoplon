import { readFile as readFileFromFs } from 'node:fs/promises';

import {
  type CreateScipProviderOptions,
  type ScipIndexState,
  type ScipProvider,
  type ScipReadFile,
  type ScipReferenceResult,
  type ScipSnapshot,
  ScipSnapshotSchema,
} from './types.js';
import {
  ScipIndexNotFoundError,
  ScipIndexParseError,
  ScipIndexStaleError,
} from './errors.js';

type LoadedScipIndex = {
  state: ScipIndexState;
  referencesBySymbol: Map<string, ScipReferenceResult[]>;
  dependenciesByFile: Map<string, string[]>;
};

const DEFAULT_READ_FILE: ScipReadFile = async (path) => readFileFromFs(path);

function toSortedUnique(values: readonly string[]): string[] {
  return Array.from(new Set(values)).sort();
}

function buildLoadedScipIndex(
  snapshot: ScipSnapshot,
  expectedWorkspaceRevision: string | undefined,
): LoadedScipIndex {
  const referencesBySymbol = new Map<string, ScipReferenceResult[]>();
  const dependenciesByFile = new Map<string, string[]>();

  for (const document of snapshot.documents) {
    dependenciesByFile.set(
      document.path,
      toSortedUnique(document.dependencies),
    );
    for (const occurrence of document.occurrences) {
      if (occurrence.role !== 'reference') {
        continue;
      }
      const bucket = referencesBySymbol.get(occurrence.symbol);
      const ref = { path: document.path, byteRange: occurrence.byteRange };
      if (bucket === undefined) {
        referencesBySymbol.set(occurrence.symbol, [ref]);
      } else {
        bucket.push(ref);
      }
    }
  }

  for (const refs of referencesBySymbol.values()) {
    refs.sort((left, right) => {
      if (left.path !== right.path) {
        return left.path < right.path ? -1 : 1;
      }
      return left.byteRange[0] - right.byteRange[0];
    });
  }

  const state: ScipIndexState =
    expectedWorkspaceRevision === undefined ||
    expectedWorkspaceRevision === snapshot.metadata.workspaceRevision
      ? { status: 'ready', metadata: snapshot.metadata }
      : {
          status: 'stale',
          metadata: snapshot.metadata,
          expectedWorkspaceRevision,
        };

  return {
    state,
    referencesBySymbol,
    dependenciesByFile,
  };
}

async function loadScipIndex(
  options: CreateScipProviderOptions,
): Promise<LoadedScipIndex> {
  let raw: Uint8Array;
  try {
    raw = await (options.readFile ?? DEFAULT_READ_FILE)(options.indexPath);
  } catch (error) {
    if (
      typeof error === 'object' &&
      error !== null &&
      'code' in error &&
      error.code === 'ENOENT'
    ) {
      throw new ScipIndexNotFoundError(options.indexPath, error);
    }
    throw error;
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(new TextDecoder().decode(raw));
  } catch (error) {
    throw new ScipIndexParseError(
      options.indexPath,
      'file is not valid JSON',
      error,
    );
  }

  const parsedSnapshot = ScipSnapshotSchema.safeParse(parsedJson);
  if (!parsedSnapshot.success) {
    throw new ScipIndexParseError(
      options.indexPath,
      parsedSnapshot.error.message,
      parsedSnapshot.error,
    );
  }

  return buildLoadedScipIndex(
    parsedSnapshot.data,
    options.workspaceRevision,
  );
}

export function createScipProvider(
  options: CreateScipProviderOptions,
): ScipProvider {
  let loadedPromise: Promise<LoadedScipIndex> | undefined;

  async function getLoadedIndex(): Promise<LoadedScipIndex> {
    loadedPromise ??= loadScipIndex(options);
    return loadedPromise;
  }

  async function getIndexState(): Promise<ScipIndexState> {
    return (await getLoadedIndex()).state;
  }

  async function assertReady(): Promise<LoadedScipIndex> {
    const loaded = await getLoadedIndex();
    if (loaded.state.status === 'stale') {
      throw new ScipIndexStaleError(
        options.indexPath,
        loaded.state.expectedWorkspaceRevision,
        loaded.state.metadata.workspaceRevision,
      );
    }
    return loaded;
  }

  async function findReferences(
    _file: string,
    symbol: string,
  ): Promise<ScipReferenceResult[]> {
    const loaded = await assertReady();
    return loaded.referencesBySymbol.get(symbol)?.slice() ?? [];
  }

  async function findDependencies(filePath: string): Promise<string[]> {
    const loaded = await assertReady();
    return loaded.dependenciesByFile.get(filePath)?.slice() ?? [];
  }

  return {
    getIndexState,
    findReferences,
    findDependencies,
  };
}
