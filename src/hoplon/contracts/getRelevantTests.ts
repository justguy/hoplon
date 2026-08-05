/**
 * contracts/getRelevantTests.ts — GetRelevantTestsRequest and TestOracleResult
 * Zod schemas and inferred types.
 *
 * LC10 — Phase 2 Stage C additive slice.
 *
 * TestOracleResult is the output of the static test oracle:
 *   - relevantTests       — test file paths that import (directly or transitively)
 *                           one or more of the modified files, within maxDepth hops.
 *   - coverageConfidence  — 'exact' when imports resolved statically and
 *                           modified inputs fit the JS/TS import graph;
 *                           'conservative' when dynamic import/require,
 *                           config/package/generated, or non-code inputs make
 *                           coverage incomplete.
 *   - unusedModifiedFiles — modified files not imported by any test in the project
 *                           (potential dead code signal).
 */

import { z } from 'zod';
import { StrictEngagementContextSchema } from './engagementContext.js';
import {
  DeterministicCoverageSchema,
  DeterministicRelevantTestSchema,
  SemanticToAffinityPromotionSuggestionSchema,
} from './testAffinity.js';

// ---------------------------------------------------------------------------
// GetRelevantTestsRequest
// ---------------------------------------------------------------------------

export const GetRelevantTestsRequestSchema = z.object({
  projectId: z.string().min(1, 'projectId must be non-empty'),
  runId: z.string().min(1, 'runId must be non-empty'),
  correlationId: z.string().min(1, 'correlationId must be non-empty'),
  /**
   * Optional outside the compatibility profile. Required by strict-agent
   * transport wrappers before static test-oracle dispatch.
   */
  engagement: StrictEngagementContextSchema.optional(),
  /**
   * Relative paths (from fs root) of the files that were modified.
   * At least one required.
   */
  modifiedFiles: z.array(z.string().min(1)).min(1, 'modifiedFiles must not be empty'),
  /**
   * Optional list of glob-like patterns used to identify test files.
   * A file is considered a test file if its path contains at least one of these
   * substrings (case-sensitive). Defaults to ['.test.', '.spec.', '/tests/'].
   *
   * Note: patterns are substring matches, not full glob expansion.
   * This is sufficient for standard JS/TS test conventions without requiring
   * a glob dependency.
   */
  testPatterns: z
    .array(z.string().min(1))
    .optional()
    .default(['.test.', '.spec.', '/tests/']),
  /**
   * BFS traversal depth limit.
   * depth=1 → only direct importers of modifiedFiles.
   * depth=2 → direct importers + importers of those importers.
   * Default: 2 (per recs §15.10 recommendation).
   */
  maxDepth: z.number().int().min(1).max(10).optional().default(2),
  advisoryIntelligence: z
    .object({
      semanticSearch: z
        .object({
          enabled: z.boolean().optional().default(true),
          topK: z.number().int().positive().optional(),
          sessionId: z.string().min(1).optional(),
          freshness: z.enum(['indexed', 'live_session']).optional(),
          allowDegraded: z.boolean().optional(),
          allowStale: z.boolean().optional(),
          resultFields: z.enum(['path_only', 'path_and_symbol', 'snippet']).optional(),
        })
        .optional(),
    })
    .optional(),
});

export type GetRelevantTestsRequest = z.infer<typeof GetRelevantTestsRequestSchema>;

const DidYouMeanSuggestionSchema = z.object({
  value: z.string().min(1),
  source: z.enum(['deterministic_exact', 'semantic_search']),
  provenance: z.object({
    kind: z.enum(['path_token', 'semantic_match']),
    matched: z.string().min(1),
    resultFields: z.enum(['path_only', 'path_and_symbol', 'snippet']).optional(),
  }),
});

const StaticOracleBlindSpotSchema = z.object({
  source: z.enum(['static_oracle', 'versioned_project_config', 'tested_framework_adapter']),
  reason: z.enum([
    'dynamic_import',
    'generated_file',
    'config_or_package_file',
    'non_code_file',
  ]),
  path: z.string().min(1).optional(),
  message: z.string().min(1),
});

const SemanticRelevantTestCandidateSchema = z.object({
  path: z.string().min(1),
  advisoryOnly: z.literal(true),
  reason: z.string().min(1),
  source: z.literal('semantic_search'),
  provenance: z.object({
    blindSpotReason: z.string().min(1),
    resultFields: z.enum(['path_only', 'path_and_symbol', 'snippet']),
    semanticSearch: z.object({
      id: z.string().min(1),
      score: z.number().min(0).max(1),
      status: z.enum(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE', 'EMPTY']),
      freshness: z.enum(['indexed', 'live_session', 'stale', 'unavailable']),
      degradationReasons: z.array(z.string()),
    }),
  }),
});

// ---------------------------------------------------------------------------
// TestOracleResult
// ---------------------------------------------------------------------------

export const TestOracleResultSchema = z.object({
  /**
   * Sorted list of test file paths (relative to fs root) that import one or
   * more of the modified files directly or transitively within maxDepth hops.
   * Sorted for H7 determinism.
   */
  relevantTests: z.array(z.string()),
  /**
   * 'exact'        — static import graph can account for the modified inputs.
   * 'conservative' — dynamic imports or conservative modified inputs were detected;
   *                  callers should avoid treating selected tests as sufficient.
   */
  coverageConfidence: z.enum(['exact', 'conservative']),
  /**
   * Sorted list of modified files that are not imported by any test file in
   * the project (within the scanned file set). Potential dead code signal.
   * Sorted for H7 determinism.
   */
  unusedModifiedFiles: z.array(z.string()),
  /**
   * Optional non-authoritative hints for callers whose provided selector inputs
   * did not match the scanned project. These are diagnostics only; Hoplon never
   * rewrites caller inputs or treats suggestions as selected tests.
   */
  diagnostics: z
    .object({
      unmatchedTestPatterns: z.array(z.object({
        pattern: z.string(),
        message: z.string(),
        didYouMean: z.array(z.string()),
        suggestions: z.array(DidYouMeanSuggestionSchema).optional(),
      })),
      unmatchedModifiedFiles: z.array(z.object({
        path: z.string().min(1),
        message: z.string().min(1),
        didYouMean: z.array(z.string()),
        suggestions: z.array(DidYouMeanSuggestionSchema),
      })).optional(),
      blindSpots: z.array(StaticOracleBlindSpotSchema).optional(),
      semanticRelevantTestCandidates: z
        .array(SemanticRelevantTestCandidateSchema.extend({
          promotionSuggestion: SemanticToAffinityPromotionSuggestionSchema.optional(),
        }))
        .optional(),
    })
    .optional(),
  deterministicRelevantTests: z.array(DeterministicRelevantTestSchema).optional(),
  deterministicCoverage: DeterministicCoverageSchema.optional(),
  semanticAdvisoryUsed: z.boolean().optional(),
});

export type TestOracleResult = z.infer<typeof TestOracleResultSchema>;
