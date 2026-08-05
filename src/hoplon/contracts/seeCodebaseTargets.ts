import { z } from 'zod';

export const SeeCodebaseAstNodeSelectorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('symbol'),
    name: z.string().min(1),
  }),
  z.object({
    kind: z.literal('symbol_path'),
    symbolPath: z.array(z.string().min(1)).min(1),
  }),
]);
export type SeeCodebaseAstNodeSelector = z.infer<
  typeof SeeCodebaseAstNodeSelectorSchema
>;

export const SeeCodebaseAstNodeExpectedIdentitySchema = z.object({
  stableId: z.string().min(1).optional(),
  nodeKind: z.string().min(1).optional(),
  byteRange: z
    .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
    .optional(),
  contentSha256: z.string().min(1).optional(),
  grammarVersion: z.string().min(1).optional(),
});
export type SeeCodebaseAstNodeExpectedIdentity = z.infer<
  typeof SeeCodebaseAstNodeExpectedIdentitySchema
>;

const SeeCodebaseTargetFileSchema = z.object({
  kind: z.literal('file'),
  path: z.string().min(1),
});

const SeeCodebaseTargetSymbolSchema = z.object({
  kind: z.literal('symbol'),
  name: z.string().min(1),
  file: z.string().min(1).optional(),
});

const SeeCodebaseTargetAstNodeSchema = z.object({
  kind: z.literal('ast_node'),
  file: z.string().min(1),
  selector: SeeCodebaseAstNodeSelectorSchema,
  expectedIdentity: SeeCodebaseAstNodeExpectedIdentitySchema.optional(),
});

const SeeCodebaseTargetEditSliceSchema = z.object({
  kind: z.literal('edit_slice'),
  path: z.string().min(1),
  startLine: z.number().int().positive(),
  endLine: z.number().int().positive(),
});

const SeeCodebaseTargetPatternSchema = z.object({
  kind: z.literal('pattern'),
  regex: z.string().min(1),
  scope: z.array(z.string().min(1)).optional(),
});

const SeeCodebaseTargetProjectSchema = z.object({
  kind: z.literal('project'),
});

export const SeeCodebaseTargetSchema = z.discriminatedUnion('kind', [
  SeeCodebaseTargetFileSchema,
  SeeCodebaseTargetSymbolSchema,
  SeeCodebaseTargetAstNodeSchema,
  SeeCodebaseTargetEditSliceSchema,
  SeeCodebaseTargetPatternSchema,
  SeeCodebaseTargetProjectSchema,
]);
export type SeeCodebaseTarget = z.infer<typeof SeeCodebaseTargetSchema>;
