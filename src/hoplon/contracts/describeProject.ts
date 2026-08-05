/**
 * contracts/describeProject.ts — DescribeProjectRequest / DescribeProjectResult
 * Zod schemas and inferred types.
 *
 * t-056 — Local AST-aware project-orientation slice.
 *
 * DescribeProject answers high-level "what is in this codebase?" questions
 * structurally. It walks the project tree, classifies files by tree-sitter
 * grammar, and aggregates the structural-template counts (exports, imports,
 * type declarations, and the top-of-bundle function/class declarations) so
 * an agent or human can orient without reading every file.
 *
 * The result is intentionally a counts-and-paths summary; per-symbol detail
 * lives in `searchSymbols` / `extractStructuralTemplate`. Limits keep parse
 * cost predictable.
 */

import { z } from 'zod';
import { StrictEngagementContextSchema } from './engagementContext.js';

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

const MAX_FILES_HARD_CEILING = 5_000;
const DEFAULT_MAX_FILES = 1_000;
const SAMPLE_PATHS_HARD_CEILING = 200;
const DEFAULT_SAMPLE_PATHS = 25;

// ---------------------------------------------------------------------------
// DescribeProjectRequest
// ---------------------------------------------------------------------------

export const DescribeProjectRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /**
   * Optional outside the compatibility profile. Required by strict-agent
   * transport wrappers before project orientation dispatch.
   */
  engagement: StrictEngagementContextSchema.optional(),

  /**
   * Cap on the number of files actually parsed for symbol counts. Discovery
   * still walks the full tree (for file-count totals); symbol aggregation is
   * limited to the first `maxFiles` paths in deterministic alphabetical
   * order. Default 1000. Hard ceiling 5000.
   */
  maxFiles: z
    .number()
    .int()
    .positive()
    .max(MAX_FILES_HARD_CEILING)
    .optional()
    .default(DEFAULT_MAX_FILES),

  /**
   * Cap on the per-language sample path list returned for orientation.
   * Default 25, hard ceiling 200.
   */
  samplePathsPerLanguage: z
    .number()
    .int()
    .positive()
    .max(SAMPLE_PATHS_HARD_CEILING)
    .optional()
    .default(DEFAULT_SAMPLE_PATHS),
});

/**
 * Request type uses `z.input` so callers may omit defaulted fields
 * (`maxFiles`, `samplePathsPerLanguage`). Internal parsing fills defaults.
 */
export type DescribeProjectRequest = z.input<typeof DescribeProjectRequestSchema>;

// ---------------------------------------------------------------------------
// DescribeProjectResult
// ---------------------------------------------------------------------------

export const SUPPORTED_PROJECT_LANGUAGES = ['javascript', 'typescript', 'tsx'] as const;
export const ProjectLanguageSchema = z.enum(SUPPORTED_PROJECT_LANGUAGES);
export type ProjectLanguage = z.infer<typeof ProjectLanguageSchema>;

const LanguageBreakdownSchema = z.object({
  language: ProjectLanguageSchema,
  fileCount: z.number().int().nonnegative(),
  /**
   * Up to `samplePathsPerLanguage` deterministic sample paths (alphabetical),
   * intended as orientation cues, not an exhaustive listing.
   */
  samplePaths: z.array(z.string().min(1)),
});

const SymbolTotalsSchema = z.object({
  exports: z.number().int().nonnegative(),
  imports: z.number().int().nonnegative(),
  types: z.number().int().nonnegative(),
  functions: z.number().int().nonnegative(),
  classes: z.number().int().nonnegative(),
});

const DescribeProjectFailureSchema = z.object({
  path: z.string().min(1),
  reason: z.enum([
    'file_not_found',
    'parse_failure',
    'invalid_query',
    'unsupported_extension',
  ]),
  message: z.string(),
});

export const DescribeProjectResultSchema = z.object({
  /** Total source files discovered, by language and overall. */
  files: z.object({
    total: z.number().int().nonnegative(),
    byLanguage: z.array(LanguageBreakdownSchema),
  }),
  /**
   * Aggregated structural counts across the parsed sample (`maxFiles`).
   * Counts reflect what tree-sitter actually found — they are exact for the
   * successfully parsed portion of the sample, not project-wide estimates.
   */
  symbols: SymbolTotalsSchema,
  /**
   * The sample size submitted to the structural pass. Equal to
   * `min(maxFiles, files.total)`. If `failures` is non-empty, some of these
   * files did not contribute counts.
   */
  filesScanned: z.number().int().nonnegative(),
  /** True when discovery surfaced more files than the parsed sample. */
  truncated: z.boolean(),
  /**
   * Per-file structural failures from the sampled files. This keeps the
   * result honest when counts come from only the successfully parsed subset
   * of the alphabetical sample.
   */
  failures: z.array(DescribeProjectFailureSchema),
});

export type DescribeProjectResult = z.infer<typeof DescribeProjectResultSchema>;
