import type { FolderPolicy } from './projectPolicy.js';

export interface ProjectPolicy {
  revertAllowlist?: readonly string[];
  secretPatterns?: readonly RegExp[];
  maxFileBytes?: number;
  parseTimeoutMs?: number;
  folderPolicy?: FolderPolicy;
}

export interface RegisteredProject {
  readonly projectId: string;
  readonly fsRoot: string;
  readonly gitRepoDir: string;
  readonly dbPath: string;
  readonly grammarsDir: string;
  readonly engineId: string;
  readonly policy: ProjectPolicy;
  readonly label: string;
  readonly registeredAtIso: string;
}

export interface RegisterProjectInput {
  projectId: string;
  fsRoot: string;
  gitRepoDir?: string;
  dbPath?: string;
  grammarsDir?: string;
  engineId?: string;
  policy?: ProjectPolicy;
  label?: string;
  registeredAtIso?: string;
}

export type ProjectRegistryErrorKind =
  | 'duplicate_project'
  | 'unknown_project'
  | 'invalid_input';

export class ProjectRegistryError extends Error {
  public readonly kind: ProjectRegistryErrorKind;
  public readonly projectId?: string;

  constructor(
    kind: ProjectRegistryErrorKind,
    message: string,
    projectId?: string,
  ) {
    super(message);
    this.name = 'ProjectRegistryError';
    this.kind = kind;
    if (projectId !== undefined) this.projectId = projectId;
  }
}

export interface ProjectRegistry {
  register(input: RegisterProjectInput): RegisteredProject;
  unregister(projectId: string): void;
  get(projectId: string): RegisteredProject | null;
  list(): readonly RegisteredProject[];
  has(projectId: string): boolean;
  getActive(): RegisteredProject | null;
  setActive(projectId: string): void;
  clearActive(): void;
  size(): number;
}

export interface CreateProjectRegistryOptions {
  seed?: readonly RegisteredProject[];
  activeProjectId?: string;
}
