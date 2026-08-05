import { authorizeAndAuditProofAccess } from '../contracts/complianceAccess.js';
import type {
  ProofAccessAuditSink,
  ProofAccessClass,
  ProofAccessObjectType,
  ProofAccessPolicy,
} from '../contracts/complianceAccess.js';

export type TraceToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface TraceEnterpriseAccessOptions {
  policy: ProofAccessPolicy;
  auditSink: ProofAccessAuditSink;
  principalId: string | null;
  engineId: string;
  now?: () => string;
}

export async function requireTraceEnterpriseAccess(
  enterpriseAccess: TraceEnterpriseAccessOptions | undefined,
  request: {
    accessClass: ProofAccessClass;
    objectType: ProofAccessObjectType;
    objectRef: string;
    projectId: string | null;
    runId: string | null;
  },
): Promise<TraceToolCallResult | null> {
  if (!enterpriseAccess) return null;
  const decision = await authorizeAndAuditProofAccess(
    {
      ...request,
      principalId: enterpriseAccess.principalId,
      engineId: enterpriseAccess.engineId,
      correlationId: request.objectRef,
      requestedAt: enterpriseAccess.now?.() ?? new Date().toISOString(),
    },
    enterpriseAccess.policy,
    enterpriseAccess.auditSink,
  );
  if (decision.outcome === 'GRANTED') return null;
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          kind: decision.reasonCode,
          message: `proof access denied: ${decision.reasonCode}`,
        }),
      },
    ],
    isError: true,
  };
}
