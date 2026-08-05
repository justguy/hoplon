/**
 * transport/strictSessionList.ts — engagement-scoped session listing for
 * strict-agent transports (hcr-004 finding 4).
 *
 * Strict session listing no longer bypasses engagement checks: the caller
 * presents a project id + engagement context, the token is verified through
 * the existing gate (and audited through the existing policy-audit seam),
 * and only sessions whose recorded owner matches the verified engagement
 * scope are returned. Shared by the HTTP `POST /session/list` route and the
 * strict MCP `session_list` tool so both surfaces stay on one path.
 */

import { z } from 'zod';

import { StrictEngagementContextSchema } from '../contracts/engagementContext.js';
import type { SessionRegistry } from '../session/registry.js';
import { SessionTransportError } from '../session/transport.js';
import {
  verifyStrictEngagementAccess,
  type StrictEngagementGateDeps,
} from './strictEngagementGate.js';

export const StrictSessionListRequestSchema = z.object({
  projectId: z.string().min(1),
  correlationId: z.string().min(1).optional(),
  /** Required in strict mode; a missing context is a typed 401 at the gate. */
  engagement: StrictEngagementContextSchema.optional(),
});
export type StrictSessionListRequest = z.infer<
  typeof StrictSessionListRequestSchema
>;

export interface StrictSessionListEntry {
  readonly sessionId: string;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly createdAtMs: number;
}

/**
 * Verify the caller's engagement and return only the sessions they own:
 * same project, and a recorded owner equal to the verified engagement
 * scope. Sessions without a recorded owner are never listed in strict
 * mode (fail closed).
 */
export async function strictScopedSessionList(args: {
  readonly gate: StrictEngagementGateDeps;
  readonly registry: SessionRegistry;
  readonly rawBody: unknown;
}): Promise<{ sessions: readonly StrictSessionListEntry[] }> {
  const parsed = StrictSessionListRequestSchema.safeParse(args.rawBody);
  if (!parsed.success) {
    throw new SessionTransportError(
      'invalid_request',
      'list: strict session listing requires { projectId, engagement }',
    );
  }
  const correlationId = parsed.data.correlationId ?? 'session-list';
  await verifyStrictEngagementAccess(args.gate, {
    ...(parsed.data.engagement !== undefined
      ? { engagement: parsed.data.engagement }
      : {}),
    projectId: parsed.data.projectId,
    runId: 'session-list',
    correlationId,
    action: 'read',
    requiredAccess: 'read_only',
  });
  const engagement = parsed.data.engagement;
  const sessions = args.registry
    .list()
    .filter(
      (info) =>
        info.projectId === parsed.data.projectId &&
        info.owner !== undefined &&
        engagement !== undefined &&
        info.owner.folder === engagement.folder &&
        info.owner.principalId === engagement.principalId,
    )
    .map((info) => ({
      sessionId: info.sessionId,
      projectId: info.projectId,
      runId: info.runId,
      correlationId: info.correlationId,
      createdAtMs: info.createdAtMs,
    }));
  return { sessions };
}
