/**
 * mcp/traceTools.ts — durable trace read/export MCP tools (t-068).
 *
 * Exposes the TraceStore read surface through MCP tools so an external
 * trace viewer or agent can retrieve durable ExecutionTrace / Attempt /
 * ProofBundle / DecisionProvenance records plus a full JSON export. The
 * tools here are strictly read-only; session.traceWriter is the sole writer.
 *
 * These sit beside the existing engine + session tool registries in
 * server.ts and are registered only when a TraceStore is supplied to the
 * MCP server factory — the pre-t-068 MCP surface is unaffected when the
 * option is omitted.
 */

import { z } from 'zod';
import type { ZodTypeAny } from 'zod';

import type { TraceStore, TraceSearchFilters } from '../adapters/traceStore.js';
import { ExecutionStatusSchema } from '../contracts/executionTrace.js';
import { toMcpInputSchema } from './inputSchema.js';
import {
  requireTraceEnterpriseAccess,
  type TraceEnterpriseAccessOptions,
} from './traceAccess.js';

// ---------------------------------------------------------------------------
// Shared tool types (mirrors sessionTools.ts shape)
// ---------------------------------------------------------------------------

type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface TraceToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

const TraceSearchFiltersSchema = z
  .object({
    projectId: z.string().optional(),
    runId: z.string().optional(),
    status: ExecutionStatusSchema.optional(),
    auditRef: z.string().optional(),
    snapshotRef: z.string().optional(),
    path: z.string().optional(),
    createdAfter: z.string().optional(),
  })
  .strict();

const ExecutionIdSchema = z.object({ executionId: z.string().min(1) }).strict();
const AttemptIdSchema = z.object({ attemptId: z.string().min(1) }).strict();
const ProofBundleRefSchema = z.object({ proofBundleRef: z.string().min(1) }).strict();
const ViolationIdSchema = z.object({ violationId: z.string().min(1) }).strict();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function toInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  return toMcpInputSchema(schema);
}

function okResult(value: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function errResult(err: unknown, kindFallback = 'trace_tool_error'): ToolCallResult {
  let kind = kindFallback;
  if (err instanceof Error) {
    const asHoplon = err as Error & { kind?: string };
    kind = typeof asHoplon.kind === 'string' ? asHoplon.kind : err.name || kindFallback;
  }
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          kind,
          message: `Hoplon trace error: ${kind}`,
        }),
      },
    ],
    isError: true,
  };
}

function notFoundResult(kind: string, id: string): ToolCallResult {
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: true, kind, message: `${kind}: ${id}` }),
      },
    ],
    isError: true,
  };
}

async function parseAnd<T>(
  schema: ZodTypeAny,
  args: Record<string, unknown>,
  op: (parsed: T) => Promise<ToolCallResult>,
): Promise<ToolCallResult> {
  const parsed = schema.safeParse(args);
  if (!parsed.success) {
    return errResult(
      Object.assign(new Error(parsed.error.message), { kind: 'invalid_request' }),
      'invalid_request',
    );
  }
  try {
    return await op(parsed.data as T);
  } catch (err) {
    return errResult(err);
  }
}

// ---------------------------------------------------------------------------
// buildTraceToolRegistry
// ---------------------------------------------------------------------------

export interface TraceToolsOptions {
  traceStore: TraceStore;
  enterpriseAccess?: TraceEnterpriseAccessOptions;
}

export function buildTraceToolRegistry(
  opts: TraceToolsOptions,
): TraceToolDefinition[] {
  const { traceStore, enterpriseAccess } = opts;

  return [
    {
      name: 'list_executions',
      description:
        'List durable Hoplon execution traces filtered by project/run/status/' +
        'auditRef/snapshotRef/path/createdAfter. Returns records sorted by ' +
        'createdAt ascending. Read-only.',
      inputSchema: toInputSchema(TraceSearchFiltersSchema),
      handler: (args) =>
        parseAnd<TraceSearchFilters>(TraceSearchFiltersSchema, args, async (filters) => {
          const executions = await traceStore.listExecutions(filters);
          return okResult({ executions });
        }),
    },
    {
      name: 'get_execution',
      description:
        'Fetch one execution plus its ordered attempts, proof bundles, and ' +
        'decision provenance entries. Blocked attempts remain visible after ' +
        'later success. Returns 404-shape error envelope if the executionId ' +
        'is unknown.',
      inputSchema: toInputSchema(ExecutionIdSchema),
      handler: (args) =>
        parseAnd<{ executionId: string }>(ExecutionIdSchema, args, async ({ executionId }) => {
          const execution = await traceStore.getExecution(executionId);
          if (!execution) return notFoundResult('execution_not_found', executionId);
          const denied = await requireTraceEnterpriseAccess(enterpriseAccess, {
            accessClass: 'raw_proof',
            objectType: 'execution',
            objectRef: executionId,
            projectId: execution.projectId,
            runId: execution.runId,
          });
          if (denied) return denied;
          const [attempts, proofBundles, provenance] = await Promise.all([
            traceStore.listAttempts(executionId),
            traceStore.listProofBundles(executionId),
            traceStore.listProvenance(executionId),
          ]);
          return okResult({ execution, attempts, proofBundles, provenance });
        }),
    },
    {
      name: 'get_attempt',
      description:
        'Fetch a single Attempt row by attemptId. Each attempt links to its ' +
        'ProofBundle and the execution it belongs to.',
      inputSchema: toInputSchema(AttemptIdSchema),
      handler: (args) =>
        parseAnd<{ attemptId: string }>(AttemptIdSchema, args, async ({ attemptId }) => {
          const attempt = await traceStore.getAttempt(attemptId);
          if (!attempt) return notFoundResult('attempt_not_found', attemptId);
          return okResult(attempt);
        }),
    },
    {
      name: 'get_proof_bundle',
      description:
        'Fetch a ProofBundle (the raw, immutable AuditResult payload) and its ' +
        'indexed violations by proofBundleRef.',
      inputSchema: toInputSchema(ProofBundleRefSchema),
      handler: (args) =>
        parseAnd<{ proofBundleRef: string }>(
          ProofBundleRefSchema,
          args,
          async ({ proofBundleRef }) => {
            const denied = await requireTraceEnterpriseAccess(enterpriseAccess, {
              accessClass: 'raw_proof',
              objectType: 'proof_bundle',
              objectRef: proofBundleRef,
              projectId: null,
              runId: null,
            });
            if (denied) return denied;
            const bundle = await traceStore.getProofBundle(proofBundleRef);
            if (!bundle) return notFoundResult('proof_bundle_not_found', proofBundleRef);
            const violations = await traceStore.listViolations(proofBundleRef);
            return okResult({ bundle, violations });
          },
        ),
    },
    {
      name: 'get_violation',
      description:
        'Fetch a single denormalised ProofViolation row by violationId. Each ' +
        'violation carries path / symbolName / nodeKind / byteRange as written ' +
        'into the indexed trace store.',
      inputSchema: toInputSchema(ViolationIdSchema),
      handler: (args) =>
        parseAnd<{ violationId: string }>(ViolationIdSchema, args, async ({ violationId }) => {
          const violation = await traceStore.getViolation(violationId);
          if (!violation) return notFoundResult('violation_not_found', violationId);
          return okResult(violation);
        }),
    },
    {
      name: 'search_traces',
      description:
        'Search Attempt rows by any combination of TraceSearchFilters — ' +
        'projectId/runId/status/auditRef/snapshotRef/path/createdAfter. path ' +
        'matches against the denormalised violation path index, and status ' +
        'matches Attempt.status so historical BLOCK rows remain searchable ' +
        'after a later PASS. Returns attempts sorted by createdAt ascending.',
      inputSchema: toInputSchema(TraceSearchFiltersSchema),
      handler: (args) =>
        parseAnd<TraceSearchFilters>(TraceSearchFiltersSchema, args, async (filters) => {
          const attempts = await traceStore.searchAttempts(filters);
          return okResult({ filters, attempts });
        }),
    },
    {
      name: 'export_execution_json',
      description:
        'Export one execution\'s full durable record set as a JSON bundle ' +
        '(execution + attempts + proof bundles + violations + provenance + ' +
        'exportedAt + schemaVersion). Suitable for archival or handoff to a ' +
        'compliance reviewer.',
      inputSchema: toInputSchema(ExecutionIdSchema),
      handler: (args) =>
        parseAnd<{ executionId: string }>(ExecutionIdSchema, args, async ({ executionId }) => {
          const execution = await traceStore.getExecution(executionId);
          if (!execution) return notFoundResult('execution_not_found', executionId);
          const denied = await requireTraceEnterpriseAccess(enterpriseAccess, {
            accessClass: 'export',
            objectType: 'export_bundle',
            objectRef: executionId,
            projectId: execution.projectId,
            runId: execution.runId,
          });
          if (denied) return denied;
          const bundle = await traceStore.exportExecution(executionId);
          if (!bundle) return notFoundResult('execution_not_found', executionId);
          return okResult(bundle);
        }),
    },
  ];
}
