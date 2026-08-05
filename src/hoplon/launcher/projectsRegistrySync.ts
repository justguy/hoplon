/**
 * launcher/projectsRegistrySync.ts — keep a live ProjectRegistry aligned
 * with the launcher-owned durable projects store snapshot.
 */

import type {
  ProjectRegistry,
  RegisteredProject,
} from '../concurrency/projectRegistry.js';
import { toPersistedProject } from './projectsStoreSchema.js';

export interface ProjectsRegistrySnapshot {
  projects: readonly RegisteredProject[];
  activeProjectId: string | null;
}

export function syncProjectRegistry(
  registry: ProjectRegistry,
  snapshot: ProjectsRegistrySnapshot,
): void {
  const nextById = new Map(snapshot.projects.map((p) => [p.projectId, p]));
  for (const current of registry.list()) {
    const next = nextById.get(current.projectId);
    if (next === undefined || !sameProject(current, next)) {
      registry.unregister(current.projectId);
    }
  }
  for (const next of snapshot.projects) {
    if (!registry.has(next.projectId)) {
      registry.register(next);
    }
  }
  if (snapshot.activeProjectId === null) {
    registry.clearActive();
  } else {
    registry.setActive(snapshot.activeProjectId);
  }
}

function sameProject(a: RegisteredProject, b: RegisteredProject): boolean {
  return (
    JSON.stringify(toPersistedProject(a)) ===
    JSON.stringify(toPersistedProject(b))
  );
}
