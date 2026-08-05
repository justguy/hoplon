import { DescribeProjectRequestSchema } from '../contracts/describeProject.js';
import { ValidationError } from '../contracts/errors.js';
import { FindReferencingSymbolsRequestSchema } from '../contracts/referencingSymbols.js';
import { SeeCodebaseRequestSchema } from '../contracts/seeCodebase.js';
import { FindSyntaxNodeRequestSchema } from '../contracts/syntaxNodeLookup.js';
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

export function buildDiscoveryEngineTools(
  engine: HoplonEngine,
  strictEngagementGate?: StrictEngagementGateDeps,
): EngineToolDefinition[] {
  return [
    {
      name: 'find_referencing_symbols',
      description:
        'Resolve a requested symbol and return advisory referencing symbols, files, ' +
        'and locations through the configured findReferences seam. Returns ' +
        'UNAVAILABLE when no provider is bound and never affects PASS/BLOCK.',
      inputSchema: toInputSchema(FindReferencingSymbolsRequestSchema),
      async handler(args) {
        const parsed = FindReferencingSymbolsRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `find_referencing_symbols: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.findReferencingSymbols(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'find_syntax_node',
      description:
        'Resolve a supported source-file location to a typed syntax-node DTO and ' +
        'return advisory parser-health metadata. Returns no native Tree-sitter handles ' +
        'and never affects PASS/BLOCK.',
      inputSchema: toInputSchema(FindSyntaxNodeRequestSchema),
      async handler(args) {
        const parsed = FindSyntaxNodeRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `find_syntax_node: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('findSyntaxNode', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('findSyntaxNode', parsed.data);
          }
          const result = await engine.findSyntaxNode(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'describe_project',
      description:
        'Walk the project tree and return per-language file counts plus ' +
        'aggregated structural counts (exports, imports, types, functions, ' +
        'classes) over the alphabetical sample bounded by maxFiles.',
      inputSchema: toInputSchema(DescribeProjectRequestSchema),
      async handler(args) {
        const parsed = DescribeProjectRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `describe_project: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('describeProject', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('describeProject', parsed.data);
          }
          const result = await engine.describeProject(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'see_codebase',
      description:
        'Unified read/search macro. Packages the existing structural primitives ' +
        '(packContext / extractStructuralTemplate / searchSymbols / ' +
        'describeProject) together with Hoplon-owned raw file read + raw text search ' +
        'behind mode: auto|structural|raw|skeleton. mode:skeleton reuses ' +
        'extractStructuralTemplate — it is not a parallel compression engine. ' +
        'strict:true blocks silent fallback; the response envelope carries ' +
        'provenance (selectedPath, routingReason, primitivesUsed, fallback flags, ' +
        'metrics). Errors surface as { ok:false, error } envelopes.',
      inputSchema: toInputSchema(SeeCodebaseRequestSchema),
      async handler(args) {
        const parsed = SeeCodebaseRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `see_codebase: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const strictCheck = strictEngineCheckFromBody('seeCodebase', args);
          if (strictCheck && strictEngagementGate) {
            await verifyStrictEngagementAccess(strictEngagementGate, strictCheck);
            assertStrictAgentFilePolicy('seeCodebase', parsed.data);
          }
          const result = await engine.seeCodebase(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
  ];
}
