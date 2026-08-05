import type { FastifyInstance, FastifyReply, FastifyRequest } from 'fastify';

import type { TraceSearchFilters, TraceStore } from '../../adapters/traceStore.js';
import type { ExecutionStatus } from '../../contracts/executionTrace.js';
import {
  authorizeAndAuditProofAccess,
} from '../../contracts/complianceAccess.js';
import type {
  ProofAccessAuditSink,
  ProofAccessClass,
  ProofAccessObjectType,
  ProofAccessPolicy,
} from '../../contracts/complianceAccess.js';
import type { AuthContext } from './auth.js';

export interface TraceHttpRoutesOptions {
  server: FastifyInstance;
  traceStore: TraceStore;
  enterpriseAccess?: {
    policy: ProofAccessPolicy;
    auditSink: ProofAccessAuditSink;
    getAuthContext?: (req: FastifyRequest) =>
      | AuthContext
      | null
      | Promise<AuthContext | null>;
    now?: () => string;
  };
  toEngineErrorEnvelope: (err: unknown) => {
    status: number;
    body: {
      error: {
        class: string;
        kind: string;
        message: string;
        correlationId: string;
      };
    };
  };
}

const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  'IN_PROGRESS',
  'PASS',
  'BLOCK',
  'ERROR',
  'ESCALATED',
  'CLOSED',
];

function isExecutionStatus(value: unknown): value is ExecutionStatus {
  return (
    typeof value === 'string' &&
    (EXECUTION_STATUSES as readonly string[]).includes(value)
  );
}

export function parseTraceFilters(query: unknown): TraceSearchFilters {
  const source =
    query && typeof query === 'object'
      ? (query as Record<string, unknown>)
      : {};
  const filters: TraceSearchFilters = {};
  if (typeof source['projectId'] === 'string') filters.projectId = source['projectId'];
  if (typeof source['runId'] === 'string') filters.runId = source['runId'];
  if (isExecutionStatus(source['status'])) filters.status = source['status'];
  if (typeof source['auditRef'] === 'string') filters.auditRef = source['auditRef'];
  if (typeof source['snapshotRef'] === 'string') filters.snapshotRef = source['snapshotRef'];
  if (typeof source['path'] === 'string') filters.path = source['path'];
  if (typeof source['createdAfter'] === 'string') filters.createdAfter = source['createdAfter'];
  return filters;
}

export async function runTraceRoute<T>(
  reply: FastifyReply,
  opts: TraceHttpRoutesOptions,
  op: () => Promise<T>,
): Promise<void> {
  try {
    const result = await op();
    if (!reply.sent) await reply.status(200).send(result);
  } catch (err) {
    const { status, body } = opts.toEngineErrorEnvelope(err);
    await reply.status(status).send(body);
  }
}

export async function authorizeTraceEnterpriseAccess(
  req: FastifyRequest,
  reply: FastifyReply,
  opts: TraceHttpRoutesOptions,
  request: {
    accessClass: ProofAccessClass;
    objectType: ProofAccessObjectType;
    objectRef: string;
    projectId: string | null;
    runId: string | null;
  },
): Promise<boolean> {
  const enterprise = opts.enterpriseAccess;
  if (!enterprise) return true;
  const auth = (await enterprise.getAuthContext?.(req)) ?? null;
  const decision = await authorizeAndAuditProofAccess(
    {
      ...request,
      principalId: auth?.principal ?? null,
      engineId: auth?.engineId ?? 'anonymous',
      correlationId: req.id,
      requestedAt: enterprise.now?.() ?? new Date().toISOString(),
    },
    enterprise.policy,
    enterprise.auditSink,
  );
  if (decision.outcome === 'GRANTED') return true;
  await reply.status(403).send({
    error: {
      class: 'Forbidden',
      kind: decision.reasonCode,
      message: `proof access denied: ${decision.reasonCode}`,
      correlationId: req.id,
    },
  });
  return false;
}
