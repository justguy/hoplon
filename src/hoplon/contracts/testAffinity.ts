import { z } from 'zod';

export const TestAffinitySourceSchema = z.enum(['manual', 'generated']);
export type TestAffinitySource = z.infer<typeof TestAffinitySourceSchema>;

export const TestAffinitySubjectKindSchema = z.enum([
  'route',
  'mcp_tool',
  'contract',
  'exported_symbol',
  'fixture',
  'read_model',
  'file',
]);

export const TestAffinityDefinitionSchema = z.object({
  path: z.string().min(1),
  selector: z.string().min(1).optional(),
});

export const TestAffinitySubjectSchema = z.object({
  kind: TestAffinitySubjectKindSchema,
  id: z.string().min(1),
  definedIn: z.array(TestAffinityDefinitionSchema).min(1),
});

export const TestAffinityEvidenceSchema = z.object({
  kind: z.enum([
    'import_graph',
    'affinity_manifest',
    'request_invocation',
    'tool_invocation',
    'contract_reference',
    'fixture_reference',
    'exported_symbol_reference',
    'read_model_subject',
    'semantic_search',
    'generated_extractor',
  ]),
  path: z.string().min(1).optional(),
  selector: z.string().min(1).optional(),
  subjectId: z.string().min(1).optional(),
  manifestPath: z.string().min(1).optional(),
  entryId: z.string().min(1).optional(),
  detail: z.string().min(1).optional(),
});
export type TestAffinityEvidence = z.infer<typeof TestAffinityEvidenceSchema>;

export const TestAffinityTestRefSchema = z.object({
  path: z.string().min(1),
  evidence: z.array(TestAffinityEvidenceSchema).min(1),
});

export const TestAffinityEntrySchema = z.object({
  id: z.string().min(1),
  source: TestAffinitySourceSchema,
  subject: TestAffinitySubjectSchema,
  tests: z.array(TestAffinityTestRefSchema).min(1),
});
export type TestAffinityEntry = z.infer<typeof TestAffinityEntrySchema>;

export const TestAffinityManifestSchema = z.object({
  schemaVersion: z.literal(1),
  entries: z.array(TestAffinityEntrySchema),
  generator: z
    .object({
      name: z.string().min(1),
      version: z.string().min(1),
      inputDigest: z.string().min(1),
    })
    .optional(),
});
export type TestAffinityManifest = z.infer<typeof TestAffinityManifestSchema>;

export const TestAffinityIssueSchema = z.object({
  manifestPath: z.string().min(1),
  kind: z.enum(['missing', 'invalid_json', 'invalid_manifest', 'invalid_entry']),
  message: z.string().min(1),
});
export type TestAffinityIssue = z.infer<typeof TestAffinityIssueSchema>;

export const DeterministicTestSourceSchema = z.enum([
  'import_graph',
  'manual_affinity',
  'generated_affinity',
]);
export type DeterministicTestSource = z.infer<typeof DeterministicTestSourceSchema>;

export const DeterministicRelevantTestSchema = z.object({
  path: z.string().min(1),
  sources: z.array(DeterministicTestSourceSchema).min(1),
  evidence: z.array(TestAffinityEvidenceSchema),
});
export type DeterministicRelevantTest = z.infer<
  typeof DeterministicRelevantTestSchema
>;

export const DeterministicCoverageSchema = z.object({
  confidence: z.enum(['exact', 'conservative']),
  selectedTestCount: z.number().int().nonnegative(),
  sourceCounts: z.object({
    importGraph: z.number().int().nonnegative(),
    manualAffinity: z.number().int().nonnegative(),
    generatedAffinity: z.number().int().nonnegative(),
  }),
  manifestStatus: z.enum(['missing', 'loaded', 'invalid', 'partial']),
  issues: z.array(TestAffinityIssueSchema),
});
export type DeterministicCoverage = z.infer<typeof DeterministicCoverageSchema>;

export const SemanticToAffinityPromotionSuggestionSchema = z.object({
  action: z.literal('add_manual_affinity_entry'),
  manifestPath: z.literal('.hoplon/test-affinity.json'),
  reason: z.string().min(1),
  entry: TestAffinityEntrySchema,
});
export type SemanticToAffinityPromotionSuggestion = z.infer<
  typeof SemanticToAffinityPromotionSuggestionSchema
>;
