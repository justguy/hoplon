import { ValidationError } from '../contracts/errors.js';
import { QueryStructureRequestSchema } from '../contracts/queryStructure.js';
import {
  DryRunRequestSchema,
  PreflightRequestSchema,
} from '../contracts/requests.js';
import { ExtractStructuralTemplateRequestSchema } from '../contracts/structuralTemplate.js';
import type { HoplonEngine } from '../engine/types.js';
import {
  errResult,
  okResult,
  toInputSchema,
  type EngineToolDefinition,
} from './engineToolSupport.js';

export function buildAuditEngineTools(engine: HoplonEngine): EngineToolDefinition[] {
  return [
    {
      name: 'dry_run',
      description:
        'Evaluate proposed file changes against the contracted manifest scope ' +
        'without touching disk. Same mathematical core as audit_diff but in-memory. ' +
        'Use this in a self-correction loop before writing to disk. ' +
        'Idempotent: same (proposedChanges, snapshotRef) → byte-identical output.',
      inputSchema: toInputSchema(DryRunRequestSchema),
      async handler(args) {
        const parsed = DryRunRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `dry_run: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.dryRun(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'preflight',
      description:
        'Run all registered Stage 1 pre-execution gates against the manifest. ' +
        'Returns PASS iff all gates pass or skip; BLOCK if any gate produces violations. ' +
        'Call this before createSnapshot to validate manifest structure early.',
      inputSchema: toInputSchema(PreflightRequestSchema),
      async handler(args) {
        const parsed = PreflightRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `preflight: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.preflight(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'query_structure',
      description:
        'Execute S-expression (tree-sitter Query DSL) queries against a set of files. ' +
        'Returns exact AST node captures. Results are sorted for determinism (H7). ' +
        'Use for discovery, blast-radius analysis, and context-gathering.',
      inputSchema: toInputSchema(QueryStructureRequestSchema),
      async handler(args) {
        const parsed = QueryStructureRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `query_structure: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.queryStructure(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'extract_structural_template',
      description:
        'Extract a deterministic structural skeleton (exports, imports, type declarations) ' +
        'from a set of files. Deterministic (H7). Idempotent. ' +
        'Use for Stage 2 LLM context injection — replaces full-file context with compact structure.',
      inputSchema: toInputSchema(ExtractStructuralTemplateRequestSchema),
      async handler(args) {
        const parsed = ExtractStructuralTemplateRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `extract_structural_template: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.extractStructuralTemplate(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
  ];
}
