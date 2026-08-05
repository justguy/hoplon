/**
 * launcher/policyAuditQuery.ts — t-089 shared programmatic / client
 * surface for the bounded policy audit query.
 *
 * One function, three callers. The HTTP route, MCP tool, and any
 * launcher-embedded caller all dispatch through `queryPolicyAudit`,
 * which is the only place that:
 *
 *   1. Validates the request through `PolicyAuditQueryRequestSchema`
 *      (so out-of-band callers cannot bypass the bounded contract).
 *   2. Calls `SnapshotStore.findPolicyAuditEntries` (the single
 *      persistence read path — no parallel reader exists).
 *   3. Projects the audit rows through `summarizePolicyAuditRows` from
 *      `transport/http/policyAuditPresent.ts`, which already drops the
 *      server-private engagement nonce and the wall-clock duration.
 *      The projection guarantees content-safety by construction: even
 *      if a future caller hands `findPolicyAuditEntries` a misshapen
 *      filter, the response cannot carry raw engagement tokens,
 *      engagement hashes, or rule bodies.
 *
 * Evidence access is NOT a gate. This module never participates in any
 * access-control decision and never widens what the caller can read on
 * any other surface.
 */

import {
  PolicyAuditEntrySchema,
  PolicyAuditQueryRequestSchema,
  PolicyAuditQueryResponseSchema,
  type PolicyAuditQueryRequest,
  type PolicyAuditQueryResponse,
} from '../contracts/policyAuditQuery.js';
import type { SnapshotStore } from '../adapters/snapshotStore.js';
import { summarizePolicyAuditRow } from '../transport/http/policyAuditPresent.js';

/**
 * Typed t-089 error class. Mirrors the per-domain error pattern used by
 * `LauncherProjectsError` and `HandshakeError` — keeps the t-089 surface
 * self-contained without expanding the global `ValidationErrorKind`
 * union.
 */
export class PolicyAuditQueryError extends Error {
  readonly kind: 'invalid_request' | 'invalid_response';
  override readonly cause?: unknown;
  constructor(
    kind: 'invalid_request' | 'invalid_response',
    message: string,
    cause?: unknown,
  ) {
    super(message);
    this.name = 'PolicyAuditQueryError';
    this.kind = kind;
    if (cause !== undefined) this.cause = cause;
  }
}

export interface QueryPolicyAuditOptions {
  /** Snapshot store backing the audit log. */
  readonly store: SnapshotStore;
  /**
   * Caller-supplied request. Untrusted by default — re-validated through
   * the contract schema even when called from a transport that already
   * parsed it. Cheap, deterministic, prevents drift.
   */
  readonly request: unknown;
}

/**
 * Execute one bounded policy audit query.
 *
 * Throws `PolicyAuditQueryError({ kind: 'invalid_request' })` when the
 * request fails the contract schema. Any persistence failure surfaces
 * as the underlying `AdapterError` from the store.
 */
export async function queryPolicyAudit(
  opts: QueryPolicyAuditOptions,
): Promise<PolicyAuditQueryResponse> {
  const parsed = PolicyAuditQueryRequestSchema.safeParse(opts.request);
  if (!parsed.success) {
    throw new PolicyAuditQueryError(
      'invalid_request',
      `queryPolicyAudit: invalid request: ${parsed.error.message}`,
      parsed.error,
    );
  }
  const request: PolicyAuditQueryRequest = parsed.data;
  const rows = await opts.store.findPolicyAuditEntries(request);
  const entries = rows.map((row) => {
    const projected = summarizePolicyAuditRow(row);
    if (projected === null) {
      throw new PolicyAuditQueryError(
        'invalid_response',
        'queryPolicyAudit: store returned a non-policy audit row',
      );
    }
    const entry = PolicyAuditEntrySchema.safeParse(projected);
    if (!entry.success) {
      throw new PolicyAuditQueryError(
        'invalid_response',
        `queryPolicyAudit: invalid policy audit entry: ${entry.error.message}`,
        entry.error,
      );
    }
    return entry.data;
  });

  const response = PolicyAuditQueryResponseSchema.safeParse({
    projectId: request.projectId,
    entries,
    limit: request.limit,
  });
  if (!response.success) {
    throw new PolicyAuditQueryError(
      'invalid_response',
      `queryPolicyAudit: invalid policy audit response: ${response.error.message}`,
      response.error,
    );
  }
  return response.data;
}
