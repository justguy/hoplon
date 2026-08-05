/** Deterministic core-operation dependency assembly. */

import type { FactoryRuntime } from './factoryRuntimeConfig.js';
import type { PackContextDeps } from '../operations/packContext.js';
import type { CreateSnapshotDeps } from '../operations/createSnapshot.js';
import type { AuditDiffDeps } from '../operations/auditDiff.js';
import type { DryRunDeps } from '../operations/dryRun.js';
import { pathTraversalGate } from '../operations/preflight.js';
import type { PreflightDeps } from '../operations/preflight.js';
import { checkTargetsGate } from '../operations/gates/checkTargets.js';
import type { RevertUncontractedDeps } from '../operations/revertUncontracted.js';
import type { HealthDeps } from '../operations/health.js';
import type { DescribeCapabilitiesDeps } from '../operations/describeCapabilities.js';
import type { QueryStructureDeps } from '../operations/queryStructure.js';
import type { ExtractStructuralTemplateDeps } from '../operations/extractStructuralTemplate.js';

export function buildFactoryCoreDeps(runtime: FactoryRuntime) {
  const {
    resolvedAdapters,
    engineId,
    fsRoot,
    gitRepoDir,
    revertAllowlist,
    maxFileBytes,
    parseTimeoutMs,
    snapshotSecretScanner,
    manifestStorageMode,
    ttlRetentionMs,
    staticAnalysis,
    embeddingProvided,
    vectorStoreProvided,
    embeddingCacheProvided,
    semanticIndexStoreProvided,
    lexicalIndexProvided,
    vectorIndexProvided,
    semanticStorageProfileProvided,
    semanticStorageProfile,
    sessionOverlayStore,
    dlp,
    dlpPolicyMode,
    startedAt,
  } = runtime;

  const packContextDeps: PackContextDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: {
      maxFileBytes,
      parseTimeoutMs,
    },
  };

  const createSnapshotDeps: CreateSnapshotDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    lockProvider: resolvedAdapters.lockProvider,
    emitter: resolvedAdapters.emitter,
    secretScanner: snapshotSecretScanner,
    dlp,
    engineId,
    config: {
      gitRepoDir,
      fsRoot,
      manifestStorageMode,
      ttlRetentionMs,
      dlpPolicyMode,
    },
  };

  const auditDiffDeps: AuditDiffDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    config: {
      fsRoot,
      gitRepoDir,
      maxFileBytes,
      parseTimeoutMs,
      manifestSchemaVersion: 1,
    },
  };

  const dryRunDeps: DryRunDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    config: {
      fsRoot,
      gitRepoDir,
      maxFileBytes,
      parseTimeoutMs,
      manifestSchemaVersion: 1,
    },
  };

  const preflightDeps: PreflightDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    config: { fsRoot, gitRepoDir },
    // Phase 2 Stage B LC1: pathTraversalGate (cheap, security) runs first;
    // checkTargetsGate (needs snapshot I/O) runs second.
    gates: [pathTraversalGate, checkTargetsGate],
  };

  const revertUncontractedDeps: RevertUncontractedDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    lockProvider: resolvedAdapters.lockProvider,
    emitter: resolvedAdapters.emitter,
    engineId,
    config: {
      gitRepoDir,
      fsRoot,
      revertAllowlist,
    },
  };

  const healthDeps: HealthDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    lockProvider: resolvedAdapters.lockProvider,
    emitter: resolvedAdapters.emitter,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    secretScanner: resolvedAdapters.secretScanner,
    staticAnalysis,
    semanticStorageProfile,
    embeddingProvided,
    vectorStoreProvided,
    embeddingCacheProvided,
    semanticIndexStoreProvided,
    lexicalIndexProvided,
    vectorIndexProvided,
    semanticStorageProfileProvided,
    sessionOverlayStore,
    manifestStorageMode,
    engineId,
    startedAt,
    gitRepoDir,
  };

  const describeCapabilitiesDeps: DescribeCapabilitiesDeps = {
    ...healthDeps,
    embeddingProvided,
    vectorStoreProvided,
  };

  const queryStructureDeps: QueryStructureDeps = {
    fs: resolvedAdapters.fs,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: {
      maxFileBytes,
      parseTimeoutMs,
    },
  };

  // LC4: extractStructuralTemplate — builds structural skeleton from files.
  // Requires versioning + snapshotStore for snapshot-mode readBlob.
  const extractStructuralTemplateDeps: ExtractStructuralTemplateDeps = {
    fs: resolvedAdapters.fs,
    versioning: resolvedAdapters.versioning,
    snapshotStore: resolvedAdapters.snapshotStore,
    codeIntelligence: resolvedAdapters.codeIntelligence,
    emitter: resolvedAdapters.emitter,
    engineId,
    root: fsRoot,
    config: {
      maxFileBytes,
      parseTimeoutMs,
      gitRepoDir,
    },
  };

  return {
    packContextDeps,
    createSnapshotDeps,
    auditDiffDeps,
    dryRunDeps,
    preflightDeps,
    revertUncontractedDeps,
    healthDeps,
    describeCapabilitiesDeps,
    queryStructureDeps,
    extractStructuralTemplateDeps,
  };
}

export type FactoryCoreDeps = ReturnType<typeof buildFactoryCoreDeps>;
