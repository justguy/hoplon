import type {
  ExtractRollbackTemplateRequest,
  RollbackTemplate,
  RollbackTemplateFile,
} from '../contracts/rollbackTemplate.js';
import type { StructuralTemplateFile } from '../contracts/structuralTemplate.js';
import { extractStructuralTemplate } from './extractStructuralTemplate.js';
import type { ExtractStructuralTemplateDeps } from './extractStructuralTemplate.js';
import type { ExtractRollbackTemplateDeps } from './extractRollbackTemplate.js';

export const DEFAULT_INJECTION_HINT =
  'Return to this structure, then apply ONLY the contracted change.';

export async function processRollbackTemplate(opts: {
  deps: ExtractRollbackTemplateDeps;
  validated: ExtractRollbackTemplateRequest;
  signal: AbortSignal | undefined;
}): Promise<RollbackTemplate> {
  const { deps, validated, signal } = opts;
  const { versioning, snapshotStore, codeIntelligence, emitter, engineId, root, config } = deps;
  const estDeps: ExtractStructuralTemplateDeps = {
    fs: deps.fs,
    versioning,
    snapshotStore,
    codeIntelligence,
    emitter,
    engineId,
    root,
    config,
  };
  const structuralTemplate = await extractStructuralTemplate(
    estDeps,
    {
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: `${validated.correlationId}--est`,
      files: validated.files,
      snapshotRefId: validated.snapshotRefId,
    },
    signal,
  );
  const files: RollbackTemplateFile[] = structuralTemplate.files.map((file) => ({
    path: file.path,
    structuralSkeleton: serializeSkeleton(file),
    contractedChanges:
      validated.contractedChangesMap?.[file.path] ?? defaultContractedChanges(file.path),
    injectionHint: DEFAULT_INJECTION_HINT,
  }));
  return {
    files,
    snapshotRef: validated.snapshotRefId,
    generatedAt: new Date().toISOString(),
  };
}

function serializeSkeleton(file: StructuralTemplateFile): string {
  const parts: string[] = [];
  if (file.exports.length > 0) {
    parts.push(`Exports: ${file.exports.map((entry) => `${entry.name} (${entry.kind})`).join(', ')}`);
  }
  if (file.imports.length > 0) {
    parts.push(`Imports: ${file.imports.map((entry) => entry.source).join(', ')}`);
  }
  if (file.types.length > 0) {
    parts.push(`Types: ${file.types.map((entry) => entry.name).join(', ')}`);
  }
  return parts.length === 0
    ? '(no exports, imports, or type declarations found at snapshot state)'
    : parts.join(' | ');
}

function defaultContractedChanges(filePath: string): string {
  return `Contracted file: ${filePath} (see manifest entries for scope)`;
}
