/**
 * authorization/activeGrantClient.ts — typed seam for fetching active
 * authorization grants from the Agentic OS Control Plane (T-145).
 *
 * Defines:
 *   - `ActiveGrant` — a single fetched grant with capability scopes and
 *     expiry metadata.
 *   - `ListActiveGrantsRequest` — the keying tuple used for lookup.
 *   - `ActiveGrantClient` — the interface adapters consume.
 *
 * Trust contract:
 *   - The Control Plane is the sole source of truth for active grants.
 *   - Grant identifiers supplied by agents (e.g. fields embedded in
 *     `HoplonAuthorizationRequest.request`) are untrusted and must NOT
 *     be passed back into OPA input. Adapters strictly use the grants
 *     returned by this client.
 *
 * Architecture rules:
 *   - Pure interface and types. No HTTP, fs, or env access here.
 *   - Errors are typed values (`{ kind: 'unavailable', reason }`), never
 *     exceptions, so adapters can apply fail-closed semantics
 *     deterministically.
 *   - Named exports only. ES modules. No `any`.
 */
import type { TokenCapabilities } from './authorizationAdapter.js';

/**
 * A single active authorization grant returned by the Control Plane.
 * The adapter forwards this verbatim into OPA input under
 * `activeGrants[]`. OPA owns matching/filtering logic; the adapter does
 * NOT pre-filter on `projectId`/`taskId`/etc. beyond what the lookup
 * key already constrained.
 */
export type ActiveGrant = {
  /** Unique grant identifier issued by the Control Plane. */
  grantId: string;
  /** Optional originating escalation request id, when supplied by the Control Plane. */
  escalationRequestId?: string;
  /** Optional lifecycle status supplied by the Control Plane active-grant API. */
  status?: string;
  /** Principal id the grant was issued to. */
  principalId: string;
  /** Task id the grant is bound to. */
  taskId: string;
  /** Project id the grant authorizes access within. */
  projectId: string;
  /** Capability-scoped permissions covered by the grant. */
  scope: TokenCapabilities;
  /** ISO 8601 expiry timestamp; OPA enforces freshness against `context.now`. */
  expiresAt: string;
};

/** Lookup key for `ActiveGrantClient.listActiveGrants`. */
export type ListActiveGrantsRequest = {
  principalId: string;
  taskId: string;
  projectId: string;
};

/** Result envelope returned by `ActiveGrantClient.listActiveGrants`. */
export type ListActiveGrantsResult =
  | { kind: 'ok'; grants: ActiveGrant[] }
  | { kind: 'unavailable'; reason: string };

/**
 * Minimal Control Plane grant lookup contract. Implementations may use
 * HTTP, gRPC, an in-memory cache, or a test stub; the adapter does not
 * care. Failures must be returned as `{ kind: 'unavailable' }` rather
 * than thrown so the adapter can fail closed for capabilities that
 * require grants and proceed with `[]` for capabilities that do not.
 */
export interface ActiveGrantClient {
  listActiveGrants(req: ListActiveGrantsRequest): Promise<ListActiveGrantsResult>;
}
