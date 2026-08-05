/**
 * contracts/seeCodebaseResults.ts — seeCodebase per-result DTOs.
 *
 * Split from seeCodebase.ts so request/envelope routing contracts stay small
 * while preserving the public re-export surface.
 */

import { z } from 'zod';
import { TokenTelemetrySchema } from './tokenTelemetry.js';

export const SeeCodebasePrimitiveIdSchema = z.enum([
  'packContext',
  'extractStructuralTemplate',
  'queryStructure',
  'searchSymbols',
  'describeProject',
  'readAstNode',
  'editSliceRead',
  'rawFileRead',
  'rawTextSearch',
]);
export type SeeCodebasePrimitiveId = z.infer<typeof SeeCodebasePrimitiveIdSchema>;

const SeeCodebaseReadProvenanceLiveFsSchema = z.object({
  kind: z.literal('live_filesystem'),
  workspaceRoot: z.string().min(1),
  filePath: z.string().min(1).optional(),
  readAtIso: z.string().datetime({ offset: false }),
});

const SeeCodebaseReadProvenanceSnapshotSchema = z.object({
  kind: z.literal('snapshot'),
  snapshotRefId: z.string().min(1),
  filePath: z.string().min(1),
  readAtIso: z.string().datetime({ offset: false }),
});

const SeeCodebaseReadProvenanceUnavailableSchema = z.object({
  kind: z.literal('unavailable'),
  reason: z.string().min(1),
});

export const SeeCodebaseReadProvenanceSchema = z.discriminatedUnion('kind', [
  SeeCodebaseReadProvenanceLiveFsSchema,
  SeeCodebaseReadProvenanceSnapshotSchema,
  SeeCodebaseReadProvenanceUnavailableSchema,
]);
export type SeeCodebaseReadProvenance = z.infer<
  typeof SeeCodebaseReadProvenanceSchema
>;

const StructuralResultSchema = z.object({
  kind: z.literal('structural'),
  primitive: z.enum([
    'packContext',
    'extractStructuralTemplate',
    'queryStructure',
    'searchSymbols',
    'describeProject',
  ]),
  payload: z.unknown(),
  readProvenance: SeeCodebaseReadProvenanceSchema,
});

const SkeletonResultSchema = z.object({
  kind: z.literal('skeleton'),
  primitive: z.literal('extractStructuralTemplate'),
  payload: z.unknown(),
  readProvenance: SeeCodebaseReadProvenanceSchema,
});

export const SeeCodebaseAstNodeIdentitySchema = z.object({
  stableId: z.string().min(1),
  path: z.string().min(1),
  symbolPath: z.array(z.string().min(1)).min(1),
  name: z.string().min(1),
  kind: z.string().min(1),
  nodeKind: z.string().min(1),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  contentSha256: z.string().min(1),
  grammarVersion: z.string().min(1),
  language: z.enum(['javascript', 'typescript', 'tsx']),
});
export type SeeCodebaseAstNodeIdentity = z.infer<
  typeof SeeCodebaseAstNodeIdentitySchema
>;

const AstNodeResultSchema = z.object({
  kind: z.literal('ast_node'),
  path: z.string().min(1),
  content: z.string(),
  identity: SeeCodebaseAstNodeIdentitySchema,
  readProvenance: SeeCodebaseReadProvenanceSchema,
});

const RawFileResultSchema = z.object({
  kind: z.literal('raw_file'),
  path: z.string().min(1),
  bytes: z.number().int().nonnegative(),
  originalBytes: z.number().int().nonnegative().optional(),
  content: z.string(),
  truncated: z.boolean(),
  readProvenance: SeeCodebaseReadProvenanceSchema,
  tokenTelemetry: TokenTelemetrySchema.optional(),
});

export const EditSliceResultSchema = z.object({
  kind: z.literal('edit_slice'),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
  byteRange: z.tuple([
    z.number().int().nonnegative(),
    z.number().int().nonnegative(),
  ]),
  content: z.string(),
  omitted: z.literal(false),
  safeToEditFrom: z.boolean(),
  encoding: z.literal('utf-8'),
  newlineStyle: z.enum(['lf', 'crlf', 'mixed', 'none']),
  anchors: z.object({
    beforeSha256: z.string().min(1),
    contentSha256: z.string().min(1),
    afterSha256: z.string().min(1),
    fullFileSha256: z.string().min(1),
  }),
  readProvenance: SeeCodebaseReadProvenanceSchema,
  tokenTelemetry: TokenTelemetrySchema.optional(),
});

const RawMatchSchema = z.object({
  path: z.string().min(1),
  line: z.number().int().positive(),
  byteOffset: z.number().int().nonnegative(),
  text: z.string(),
});

const RawSearchResultSchema = z.object({
  kind: z.literal('raw_search'),
  regex: z.string().min(1),
  matches: z.array(RawMatchSchema),
  filesScanned: z.number().int().nonnegative(),
  truncated: z.boolean(),
  readProvenance: SeeCodebaseReadProvenanceSchema,
});

export const SeeCodebaseResultSchema = z.discriminatedUnion('kind', [
  StructuralResultSchema,
  SkeletonResultSchema,
  AstNodeResultSchema,
  EditSliceResultSchema,
  RawFileResultSchema,
  RawSearchResultSchema,
]);
export type SeeCodebaseResult = z.infer<typeof SeeCodebaseResultSchema>;
