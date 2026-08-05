import { DescribeCapabilitiesRequestSchema } from '../contracts/capabilities.js';
import { ValidationError } from '../contracts/errors.js';
import {
  IndexSemanticCorpusRequestSchema,
  SemanticOverlayClearRequestSchema,
  SemanticOverlayRefreshRequestSchema,
  SemanticSearchRequestSchema,
} from '../contracts/semanticSearch.js';
import { SemanticSearchRequestValidationError } from '../contracts/semanticSearchRecovery.js';
import type { HoplonEngine } from '../engine/types.js';
import { assertStrictAgentFilePolicy } from '../transport/strictAgentFilePolicy.js';
import {
  assertStrictSemanticEngineContext,
  strictEngineCheckFromBody,
} from '../transport/strictEngagementCheck.js';
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

export function buildSemanticEngineTools(
  engine: HoplonEngine,
  strictEngagementGate?: StrictEngagementGateDeps,
): EngineToolDefinition[] {
  return [
    {
      name: 'index_semantic_corpus',
      description:
        'Index caller-supplied semantic corpus documents under a project. ' +
        'Returns provider status, indexed counts, freshness, and degradation ' +
        'reasons. Advisory retrieval only; this does not affect PASS/BLOCK.',
      inputSchema: toInputSchema(IndexSemanticCorpusRequestSchema),
      async handler(args) {
        const parsed = IndexSemanticCorpusRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `index_semantic_corpus: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('indexSemanticCorpus', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('indexSemanticCorpus', parsed.data);
          } else if (strictEngagementGate) {
            assertStrictSemanticEngineContext('indexSemanticCorpus', args);
          }
          const result = await engine.indexSemanticCorpus(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'semantic_search',
      description:
        'Run unified advisory semantic retrieval over indexed project documents, ' +
        'branch/ref snapshots, and live-session overlays. Deterministic exact reads ' +
        'and text searches belong on see_codebase; this tool returns non-blocking ' +
        'semantic matches, typed recovery guidance, and source/freshness metadata ' +
        'when semantic providers are bound.',
      inputSchema: toInputSchema(SemanticSearchRequestSchema),
      async handler(args) {
        const parsed = SemanticSearchRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new SemanticSearchRequestValidationError({
              engineId: 'mcp',
              correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
              cause: parsed.error,
            }),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('semanticSearch', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('semanticSearch', parsed.data);
          } else if (strictEngagementGate) {
            assertStrictSemanticEngineContext('semanticSearch', args);
          }
          const result = await engine.semanticSearch(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'refresh_semantic_overlay',
      description:
        'Refresh advisory live-session semantic overlay rows for touched files. ' +
        'Overlay rows remain session-scoped and never change deterministic audit authority.',
      inputSchema: toInputSchema(SemanticOverlayRefreshRequestSchema),
      async handler(args) {
        const parsed = SemanticOverlayRefreshRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `refresh_semantic_overlay: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('refreshSemanticOverlay', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('refreshSemanticOverlay', parsed.data);
          } else if (strictEngagementGate) {
            assertStrictSemanticEngineContext('refreshSemanticOverlay', args);
          }
          const result = await engine.refreshSemanticOverlay(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'clear_semantic_overlay',
      description:
        'Clear advisory live-session semantic overlay rows for one project/session.',
      inputSchema: toInputSchema(SemanticOverlayClearRequestSchema),
      async handler(args) {
        const parsed = SemanticOverlayClearRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `clear_semantic_overlay: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('clearSemanticOverlay', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('clearSemanticOverlay', parsed.data);
          } else if (strictEngagementGate) {
            assertStrictSemanticEngineContext('clearSemanticOverlay', args);
          }
          const result = await engine.clearSemanticOverlay(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'describe_capabilities',
      description:
        'Return the typed extension-capability catalog: placement, version metadata, ' +
        'side-effect posture, and failure-isolation rules. Introspection only.',
      inputSchema: toInputSchema(DescribeCapabilitiesRequestSchema),
      async handler(args) {
        const parsed = DescribeCapabilitiesRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `describe_capabilities: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.describeCapabilities(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
  ];
}
