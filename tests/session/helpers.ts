import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import type { PreflightResult } from '../../src/hoplon/contracts/preflight.js';
import type { SnapshotResult } from '../../src/hoplon/contracts/snapshot.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import type { RevertResult } from '../../src/hoplon/contracts/revert.js';
import type { RollbackTemplate } from '../../src/hoplon/contracts/rollbackTemplate.js';

export const MANIFEST: WritableManifest = {
  manifestSchemaVersion: 1,
  projectId: 'proj-session',
  runId: 'run-session-1',
  correlationId: 'corr-session-1',
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' } }],
};

export const SNAPSHOT_REF_ID = `sha256:${'a'.repeat(64)}`;

export const PASS_AUDIT: AuditResult = {
  status: 'PASS',
  correlationId: 'corr-session-1',
  checked: 1,
  auditSchemaVersion: 1,
};

export const BLOCK_AUDIT: AuditResult = {
  status: 'BLOCK',
  correlationId: 'corr-session-1',
  auditSchemaVersion: 1,
  violations: [
    {
      kind: 'uncontracted_file',
      path: 'src/foo.ts',
      firstChangedLine: 0,
      sourceSlice: '',
      message: 'uncontracted file mutation',
      correction: 'Revert this file.',
    },
  ],
};

export const PASS_PREFLIGHT: PreflightResult = {
  status: 'PASS',
  correlationId: 'corr-session-1',
  gates: [],
};

export const BLOCK_PREFLIGHT: PreflightResult = {
  status: 'BLOCK',
  correlationId: 'corr-session-1',
  gates: [
    {
      gateName: 'path_traversal',
      status: 'BLOCK',
      violations: [
        {
          kind: 'uncontracted_file',
          path: '../bad',
          firstChangedLine: 0,
          sourceSlice: '',
          message: 'escape outside root',
          correction: 'Drop the path.',
        },
      ],
      durationMs: 1,
    },
  ],
};

export const SNAPSHOT_RESULT: SnapshotResult = {
  snapshotRef: {
    id: SNAPSHOT_REF_ID,
    engineId: 'mock-engine',
    runId: 'run-session-1',
    createdAt: '2026-04-14T00:00:00Z',
  },
  warnings: [],
};

export const REVERT_RESULT: RevertResult = {
  reverted: ['src/foo.ts'],
  deleted: [],
  allowlistSkipped: [],
};

export const ROLLBACK_TEMPLATE: RollbackTemplate = {
  files: [
    {
      path: 'src/foo.ts',
      structuralSkeleton: 'export function foo(): void;',
      contractedChanges: 'Modify symbol: foo',
      injectionHint: 'Return to this structure, then apply the contracted change.',
    },
  ],
  snapshotRef: SNAPSHOT_REF_ID,
  generatedAt: '2026-04-14T00:00:00Z',
};

export function makeMockEngine(overrides: Partial<HoplonEngine> = {}): HoplonEngine {
  const base: Partial<HoplonEngine> = {
    preflight: async () => PASS_PREFLIGHT,
    createSnapshot: async () => SNAPSHOT_RESULT,
    dryRun: async () => PASS_AUDIT,
    refreshSemanticOverlay: async (req) => ({
      correlationId: req.correlationId,
      projectId: req.projectId,
      ...(req.worktreeId !== undefined ? { worktreeId: req.worktreeId } : {}),
      sessionId: req.sessionId,
      status: req.status ?? (req.documents && req.documents.length > 0 ? 'AVAILABLE' : 'EMPTY'),
      mode: req.mode,
      inputSource: req.inputSource,
      overlayGeneration: 1,
      published: true,
      retainedPreviousOverlay: false,
      touchedFileCount: req.touchedFiles.length,
      documentCount: req.documents?.length ?? 0,
      lexicalCount: req.documents?.length ?? 0,
      vectorCount: req.documents?.length ?? 0,
      maskCount: new Set(req.touchedFiles).size,
      degradationReasons: req.degradationReasons ?? [],
    }),
    clearSemanticOverlay: async (req) => ({
      correlationId: req.correlationId,
      projectId: req.projectId,
      sessionId: req.sessionId,
      cleared: true,
    }),
    auditDiff: async () => PASS_AUDIT,
    revertUncontracted: async () => REVERT_RESULT,
    extractRollbackTemplate: async () => ROLLBACK_TEMPLATE,
  };
  return { ...base, ...overrides } as HoplonEngine;
}
