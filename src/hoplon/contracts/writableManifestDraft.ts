import { z } from 'zod';

import {
  ManifestIntentSchema,
  ManifestScopeSchema,
  WritableManifestSchema,
} from './manifest.js';

const DraftPathSchema = z.string().min(1);

const DraftDefinitionSchema = z.object({
  path: DraftPathSchema,
  selector: z.string().min(1).optional(),
});

const DraftTargetFileSchema = z.object({
  kind: z.literal('file'),
  path: DraftPathSchema,
  intent: ManifestIntentSchema.optional(),
});

const DraftTargetSymbolSchema = z.object({
  kind: z.literal('symbol'),
  file: DraftPathSchema,
  symbol: z.string().min(1),
  intent: ManifestIntentSchema.optional(),
});

const DraftTargetAstNodeSchema = z.object({
  kind: z.literal('ast_node'),
  file: DraftPathSchema,
  symbolPath: z.array(z.string().min(1)).min(1),
  intent: ManifestIntentSchema.optional(),
});

const DraftTargetSubjectSchema = z.object({
  kind: z.enum([
    'route',
    'mcp_tool',
    'contract',
    'exported_symbol',
    'fixture',
    'read_model',
  ]),
  id: z.string().min(1),
  definedIn: z.array(DraftDefinitionSchema).min(1),
  intent: ManifestIntentSchema.optional(),
});

export const DraftWritableManifestTargetSchema = z.discriminatedUnion('kind', [
  DraftTargetFileSchema,
  DraftTargetSymbolSchema,
  DraftTargetAstNodeSchema,
  DraftTargetSubjectSchema,
]);
export type DraftWritableManifestTarget = z.infer<
  typeof DraftWritableManifestTargetSchema
>;

export const DraftWritableManifestRequestSchema = z.object({
  projectId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  target: DraftWritableManifestTargetSchema,
  readOnlyFiles: z.array(DraftPathSchema).optional(),
});
export type DraftWritableManifestRequest = z.infer<
  typeof DraftWritableManifestRequestSchema
>;

export const DraftManifestFileSchema = z.object({
  path: DraftPathSchema,
  scope: ManifestScopeSchema.optional(),
  reason: z.string().min(1),
});
export type DraftManifestFile = z.infer<typeof DraftManifestFileSchema>;

export const DraftWritableManifestResultSchema = z.object({
  status: z.literal('draft_requires_confirmation'),
  requiresConfirmation: z.literal(true),
  manifest: WritableManifestSchema,
  writableFiles: z.array(DraftManifestFileSchema),
  readOnlyFiles: z.array(DraftManifestFileSchema),
  reasons: z.array(z.string().min(1)),
});
export type DraftWritableManifestResult = z.infer<
  typeof DraftWritableManifestResultSchema
>;
