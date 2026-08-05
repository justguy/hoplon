import { ComputeMinimalPatchRequestSchema } from '../contracts/computeMinimalPatch.js';
import { ValidationError } from '../contracts/errors.js';
import { GetRelevantTestsRequestSchema } from '../contracts/getRelevantTests.js';
import { SearchSymbolsRequestSchema } from '../contracts/searchSymbols.js';
import type { HoplonEngine } from '../engine/types.js';
import { assertStrictAgentFilePolicy } from '../transport/strictAgentFilePolicy.js';
import { strictEngineCheckFromBody } from '../transport/strictEngagementCheck.js';
import {
  verifyStrictEngagementAccess,
  type StrictEngagementGateDeps,
} from '../transport/strictEngagementGate.js';
import {
  errResult,
  okResult,
  toInputSchema,
  type EngineToolDefinition,
} from './engineToolSupport.js';

export function buildUtilityEngineTools(
  engine: HoplonEngine,
  strictEngagementGate?: StrictEngagementGateDeps,
): EngineToolDefinition[] {
  return [
    {
      name: 'compute_minimal_patch',
      description:
        'Compute a minimal patch from a BLOCK AuditResult. ' +
        'REMOVE_NODES violations are patchable — correctedContent is populated. ' +
        'PATCH_NOT_COMPUTABLE violations provide a retryPrompt. ' +
        'Pure function: no I/O, no side effects.',
      inputSchema: toInputSchema(ComputeMinimalPatchRequestSchema),
      async handler(args) {
        const parsed = ComputeMinimalPatchRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: 'mcp',
                cause: parsed.error,
              },
              `compute_minimal_patch: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = engine.computeMinimalPatch(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'get_relevant_tests',
      description:
        'Determine which test files import the given modified files, directly or ' +
        'transitively within maxDepth hops. Pure static analysis — no LLM call, no runtime. ' +
        'Returns relevantTests, coverageConfidence, and unusedModifiedFiles.',
      inputSchema: toInputSchema(GetRelevantTestsRequestSchema),
      async handler(args) {
        const parsed = GetRelevantTestsRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `get_relevant_tests: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('getRelevantTests', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('getRelevantTests', parsed.data);
          }
          const result = await engine.getRelevantTests(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'health',
      description:
        'Probe each adapter and return engine + adapter health status. Idempotent.',
      inputSchema: { type: 'object', properties: {} },
      async handler(_args) {
        try {
          const result = await engine.health();
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'search_symbols',
      description:
        'Find declared JS/TS symbols (functions, classes, methods, exports, ' +
        'top-level types) whose names match a regex. Read-only; does not ' +
        'replace text grep for docs/logs/comments/env vars.',
      inputSchema: toInputSchema(SearchSymbolsRequestSchema),
      async handler(args) {
        const parsed = SearchSymbolsRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `search_symbols: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('searchSymbols', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('searchSymbols', parsed.data);
          }
          const result = await engine.searchSymbols(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
  ];
}
