import type {
  PortableBranchAlias,
  PortableChunkIdentity,
  PortableSemanticIndexSnapshot,
  PortableSemanticIndexStorage,
  PortableSemanticIndexStoredDocument,
  PortableSourceCommitSnapshot,
} from './types.js';

export function createEmptyPortableSemanticIndexSnapshot(): PortableSemanticIndexSnapshot {
  return {
    version: 1,
    projects: {},
    tombstones: {},
  };
}

export function clonePortableSemanticIndexSnapshot(
  snapshot: PortableSemanticIndexSnapshot,
): PortableSemanticIndexSnapshot {
  const projects: Record<string, Record<string, PortableSemanticIndexStoredDocument>> = {};
  const tombstones: PortableSemanticIndexSnapshot['tombstones'] = {};

  for (const [projectId, documents] of Object.entries(snapshot.projects)) {
    projects[projectId] = {};
    const project = projects[projectId];
    if (project === undefined) {
      continue;
    }

    for (const [documentId, document] of Object.entries(documents)) {
      project[documentId] = {
        id: document.id,
        text: document.text,
        metadata: { ...document.metadata },
        ...cloneSourceFields(document),
        updatedAtIso: document.updatedAtIso,
      };
    }
  }

  for (const [projectId, projectTombstones] of Object.entries(
    snapshot.tombstones ?? {},
  )) {
    tombstones[projectId] = {};
    const project = tombstones[projectId];
    if (project === undefined) continue;
    for (const [documentId, tombstone] of Object.entries(projectTombstones)) {
      project[documentId] = {
        id: tombstone.id,
        kind: tombstone.kind,
        updatedAtIso: tombstone.updatedAtIso,
      };
    }
  }

  return {
    version: 1,
    projects,
    tombstones,
  };
}

function cloneSourceFields(document: PortableSemanticIndexStoredDocument): {
  readonly sourceSnapshot?: PortableSourceCommitSnapshot;
  readonly branchAliases?: readonly PortableBranchAlias[];
  readonly chunkIdentity?: PortableChunkIdentity;
} {
  return {
    ...(document.sourceSnapshot === undefined
      ? {}
      : { sourceSnapshot: { ...document.sourceSnapshot } }),
    ...(document.branchAliases === undefined
      ? {}
      : { branchAliases: document.branchAliases.map((alias) => ({ ...alias })) }),
    ...(document.chunkIdentity === undefined
      ? {}
      : { chunkIdentity: cloneChunkIdentity(document.chunkIdentity) }),
  };
}

function cloneChunkIdentity(chunk: PortableChunkIdentity): PortableChunkIdentity {
  return {
    ...chunk,
    ...(chunk.lineRange === undefined
      ? {}
      : { lineRange: { ...chunk.lineRange } }),
    sourceProvenance: {
      ...chunk.sourceProvenance,
      ...(chunk.sourceProvenance.branchNames === undefined
        ? {}
        : { branchNames: [...chunk.sourceProvenance.branchNames] }),
    },
  };
}

export function createInMemoryPortableSemanticIndexStorage(
  initialSnapshot: PortableSemanticIndexSnapshot | null = null,
): PortableSemanticIndexStorage {
  let current =
    initialSnapshot === null ? null : clonePortableSemanticIndexSnapshot(initialSnapshot);

  return {
    async load(): Promise<PortableSemanticIndexSnapshot | null> {
      return current === null ? null : clonePortableSemanticIndexSnapshot(current);
    },
    async save(snapshot: PortableSemanticIndexSnapshot): Promise<void> {
      current = clonePortableSemanticIndexSnapshot(snapshot);
    },
  };
}
