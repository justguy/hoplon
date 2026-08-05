import { z } from 'zod';

import type { HoplonEngine } from '../../engine/types.js';
import {
  AuditRequestSchema,
  CreateSnapshotRequestSchema,
  DryRunRequestSchema,
  PackContextRequestSchema,
  PreflightRequestSchema,
  RevertRequestSchema,
} from '../../contracts/requests.js';
import { AuditResultSchema } from '../../contracts/audit.js';
import {
  DescribeCapabilitiesRequestSchema,
  DescribeCapabilitiesResultSchema,
} from '../../contracts/capabilities.js';
import { ComputeMinimalPatchRequestSchema, MinimalPatchSchema } from '../../contracts/computeMinimalPatch.js';
import { PackedContextSchema } from '../../contracts/context.js';
import { DescribeProjectRequestSchema, DescribeProjectResultSchema } from '../../contracts/describeProject.js';
import { GcRequestSchema, GcResultSchema } from '../../contracts/gc.js';
import { GetRelevantTestsRequestSchema, TestOracleResultSchema } from '../../contracts/getRelevantTests.js';
import { EngineHealthSchema } from '../../contracts/health.js';
import { PreflightResultSchema } from '../../contracts/preflight.js';
import { QueryStructureRequestSchema, QueryStructureResultSchema } from '../../contracts/queryStructure.js';
import { ReconcileReportSchema } from '../../contracts/reconcile.js';
import { RevertResultSchema } from '../../contracts/revert.js';
import { ExtractRollbackTemplateRequestSchema, RollbackTemplateSchema } from '../../contracts/rollbackTemplate.js';
import { CompressedRetryContextSchema, PriorAttemptSchema } from '../../contracts/retryContext.js';
import { SearchSymbolsRequestSchema, SearchSymbolsResultSchema } from '../../contracts/searchSymbols.js';
import { SnapshotResultSchema } from '../../contracts/snapshot.js';
import { ExtractStructuralTemplateRequestSchema, StructuralTemplateSchema } from '../../contracts/structuralTemplate.js';
import type { RemoteClientContext } from './clientDispatch.js';

type CoreRemoteMethods = Pick<
  HoplonEngine,
  | 'createSnapshot'
  | 'auditDiff'
  | 'revertUncontracted'
  | 'packContext'
  | 'health'
  | 'describeCapabilities'
  | 'reconcile'
  | 'dryRun'
  | 'preflight'
  | 'queryStructure'
  | 'extractStructuralTemplate'
  | 'gc'
  | 'compressRetryContext'
  | 'computeMinimalPatch'
  | 'getRelevantTests'
  | 'extractRollbackTemplate'
  | 'searchSymbols'
  | 'describeProject'
>;

function correlationId(req: { correlationId?: string }): string {
  return req.correlationId ?? 'unknown';
}

export function createRemoteCoreMethods(
  client: RemoteClientContext,
): CoreRemoteMethods {
  const post = client.post.bind(client);
  const get = client.get.bind(client);
  return {
    createSnapshot: (req, signal) =>
      post('createSnapshot', CreateSnapshotRequestSchema, SnapshotResultSchema, req, signal, req.manifest.correlationId),
    auditDiff: (req, signal) =>
      post('auditDiff', AuditRequestSchema, AuditResultSchema, req, signal, correlationId(req)),
    revertUncontracted: (req, signal) =>
      post('revertUncontracted', RevertRequestSchema, RevertResultSchema, req, signal, correlationId(req)),
    packContext: (req, signal) =>
      post('packContext', PackContextRequestSchema, PackedContextSchema, req, signal, correlationId(req)),
    health: (signal) => get('health', EngineHealthSchema, signal, 'health'),
    describeCapabilities: (req, signal) =>
      post('describeCapabilities', DescribeCapabilitiesRequestSchema, DescribeCapabilitiesResultSchema, req, signal, correlationId(req)),
    reconcile: (signal) =>
      post('reconcile', z.object({}), ReconcileReportSchema, {}, signal, 'reconcile'),
    dryRun: (req, signal) =>
      post('dryRun', DryRunRequestSchema, AuditResultSchema, req, signal, correlationId(req)),
    preflight: (req, signal) =>
      post('preflight', PreflightRequestSchema, PreflightResultSchema, req, signal, correlationId(req)),
    queryStructure: (req, signal) =>
      post('queryStructure', QueryStructureRequestSchema, QueryStructureResultSchema, req, signal, correlationId(req)),
    extractStructuralTemplate: (req, signal) =>
      post('extractStructuralTemplate', ExtractStructuralTemplateRequestSchema, StructuralTemplateSchema, req, signal, correlationId(req)),
    gc: (gcOpts) =>
      post('gc', GcRequestSchema, GcResultSchema, {
        projectId: gcOpts.projectId,
        olderThan: gcOpts.olderThan,
        expiredBefore: gcOpts.expiredBefore,
        semanticCache: gcOpts.semanticCache,
        semanticOverlays: gcOpts.semanticOverlays,
        semanticTombstones: gcOpts.semanticTombstones,
      }, undefined, 'gc'),
    compressRetryContext: (
      (attempts: Parameters<HoplonEngine['compressRetryContext']>[0]) =>
        post('compressRetryContext', z.array(PriorAttemptSchema), CompressedRetryContextSchema, attempts, undefined, 'compressRetryContext')
    ) as unknown as HoplonEngine['compressRetryContext'],
    computeMinimalPatch: (
      (req: Parameters<HoplonEngine['computeMinimalPatch']>[0]) =>
        post('computeMinimalPatch', ComputeMinimalPatchRequestSchema, MinimalPatchSchema, req, undefined, 'computeMinimalPatch')
    ) as unknown as HoplonEngine['computeMinimalPatch'],
    getRelevantTests: (req, signal) =>
      post('getRelevantTests', GetRelevantTestsRequestSchema, TestOracleResultSchema, req, signal, correlationId(req)),
    extractRollbackTemplate: (req, signal) =>
      post('extractRollbackTemplate', ExtractRollbackTemplateRequestSchema, RollbackTemplateSchema, req, signal, correlationId(req)),
    searchSymbols: (req, signal) =>
      post('searchSymbols', SearchSymbolsRequestSchema, SearchSymbolsResultSchema, req, signal, correlationId(req)),
    describeProject: (req, signal) =>
      post('describeProject', DescribeProjectRequestSchema, DescribeProjectResultSchema, req, signal, correlationId(req)),
  };
}
