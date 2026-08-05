/**
 * transport/policyAuditAccess.ts — gated-access verification helper.
 *
 * Originally lived in `policyAuditSink.ts`; extracted in t-148 so the
 * sink file stays under the 300-line architecture cap once the
 * dynamic-authz audit methods landed.
 *
 * `auditedVerifyEngagementToken` is the single seam t-085 (and every
 * future strict-engagement gate) is expected to call — it guarantees
 * every access decision is reflected in durable audit evidence.
 *
 * Returns the same `TokenVerification` shape as `verifyEngagementToken`
 * so callers keep their branch logic unchanged. Audit-write failure
 * NEVER changes the returned verification (best-effort invariant).
 */

import {
  verifyEngagementToken,
  type TokenVerification,
  type VerifyExpectation,
} from '../launcher/engagementLifecycle.js';
import type { EngagementStore } from '../launcher/engagementStore.js';
import type {
  GatedAction,
  PolicyAuditContext,
  PolicyAuditSink,
} from './policyAuditSink.js';

export async function auditedVerifyEngagementToken(args: {
  sink: PolicyAuditSink;
  store: EngagementStore;
  token: string;
  expectation: VerifyExpectation;
  action: GatedAction;
  context: PolicyAuditContext;
  clock?: () => Date;
}): Promise<TokenVerification> {
  const clock = args.clock ?? (() => new Date());
  const startMs = clock().getTime();
  const verification = verifyEngagementToken(
    args.store,
    args.token,
    args.expectation,
  );
  const durationMs = Math.max(0, clock().getTime() - startMs);
  await args.sink.recordAccessCheck(
    args.context,
    args.action,
    args.expectation,
    verification,
    durationMs,
  );
  return verification;
}
