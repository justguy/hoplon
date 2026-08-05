import { ValidationError } from '../contracts/errors.js';
import {
  AuditRequestSchema,
  CreateSnapshotRequestSchema,
  PackContextRequestSchema,
  RevertRequestSchema,
} from '../contracts/requests.js';
import type { HoplonEngine } from '../engine/types.js';
import {
  errResult,
  okResult,
  toInputSchema,
  type EngineToolDefinition,
} from './engineToolSupport.js';

export function buildCoreEngineTools(engine: HoplonEngine): EngineToolDefinition[] {
  return [
    {
      name: 'create_snapshot',
      description:
        'Capture a contracted writable scope as an isomorphic-git commit. ' +
        'Returns a content-addressable SnapshotRef and non-blocking secret-scan ' +
        'warnings. Idempotent: same manifest → same ref. ' +
        'Call this before agent execution begins.',
      inputSchema: toInputSchema(CreateSnapshotRequestSchema),
      async handler(args) {
        const parsed = CreateSnapshotRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: 'mcp',
                cause: parsed.error,
              },
              `create_snapshot: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.createSnapshot(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'audit_diff',
      description:
        'Verify that current file edits mathematically match the contracted WritableManifest. ' +
        'Returns PASS if every change lies within the contracted scope, or BLOCK with ' +
        'structured AST-level violations. Call this after execution and before committing. ' +
        'Do not use for discovery — use query_structure instead.',
      inputSchema: toInputSchema(AuditRequestSchema),
      async handler(args) {
        const parsed = AuditRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `audit_diff: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.auditDiff(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'revert_uncontracted',
      description:
        'Restore contracted files to their snapshotted state and delete any ' +
        'uncontracted post-snapshot files (modulo the engine revertAllowlist). ' +
        'NOT idempotent — do not retry blind on failure. ' +
        'Call this when auditDiff returns BLOCK and you need a clean slate.',
      inputSchema: toInputSchema(RevertRequestSchema),
      async handler(args) {
        const parsed = RevertRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `revert_uncontracted: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.revertUncontracted(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
    {
      name: 'pack_context',
      description:
        'Return AST-bounded context slices for a set of files. ' +
        'Deterministic per H7. Idempotent. ' +
        'Use this to assemble token-efficient context before code generation.',
      inputSchema: toInputSchema(PackContextRequestSchema),
      async handler(args) {
        const parsed = PackContextRequestSchema.safeParse(args);
        if (!parsed.success) {
          return errResult(
            new ValidationError(
              {
                kind: 'invalid_scope',
                engineId: 'mcp',
                correlationId: (args['correlationId'] as string | undefined) ?? 'mcp',
                cause: parsed.error,
              },
              `pack_context: invalid input: ${parsed.error.message}`,
            ),
          );
        }
        try {
          const result = await engine.packContext(parsed.data);
          return okResult(result);
        } catch (err) {
          return errResult(err);
        }
      },
    },
  ];
}
