/**
 * transport/http/auth.ts — Pluggable auth middleware hooks for the Hoplon HTTP transport.
 *
 * H25 invariant: every authenticated request carries the caller's engineId in the
 * auth context; wire payload is trusted only after middleware returns.
 *
 * H13 compliance: AuthContext content (engineId, principal, claims) never enters
 * the HoplonEvent stream. Auth decisions are pre-wire-dispatch; they are not
 * operational events and must not be emitted via HoplonEmitter.
 *
 * Design:
 * - `AuthMiddleware` is a single-method interface. Implementations receive a
 *   content-free `AuthRequest` (headers + path only — never request body) and
 *   return either a populated `AuthContext` (pass) or `null` (reject → 401).
 * - `AuthRequest` intentionally omits the request body to preserve H13: no
 *   content-bearing data flows into the auth layer.
 * - `AuthContext.engineId` is the caller's declared engineId. The transport layer
 *   trusts this value only after `authenticate()` returns non-null. Downstream
 *   engine ops use `engineId` for H5 compliance (present in every event/error).
 * - Two built-in factories ship for dev/test and Bearer token scenarios.
 *   Production deployments inject their own verifier via `createBearerTokenAuthMiddleware`.
 * - No new runtime deps — uses only Node built-ins (no crypto calls; token
 *   verification is delegated to the consumer's `verifyToken` callback).
 *
 * T1 integration seam:
 *   The server file (T1, not yet written at time of T4) should call
 *   `registerAuthMiddleware(mw)` before route registration. On each incoming
 *   request the server calls `mw.authenticate(authReq)` and rejects with HTTP 401
 *   if the result is null.  The integration hook `registerAuthMiddleware` is
 *   exported here and is the ONLY mutation point for auth state on the server.
 *   T1 wraps it in its plugin object; T4 owns the interface only.
 */

// ---------------------------------------------------------------------------
// AuthRequest — content-free request descriptor (H13 compliant)
// ---------------------------------------------------------------------------

/**
 * Stripped request shape passed to `AuthMiddleware.authenticate`.
 *
 * Contains only the structural metadata needed for authentication decisions.
 * The request body is intentionally absent: including it would allow auth
 * middleware to observe file content / manifest data, violating H13.
 */
export interface AuthRequest {
  /** HTTP request headers, lowercased keys. */
  readonly headers: Record<string, string>;
  /** Request path (e.g. '/createSnapshot'). */
  readonly path: string;
}

// ---------------------------------------------------------------------------
// AuthContext — populated on every authenticated request (H25)
// ---------------------------------------------------------------------------

/**
 * Authentication context attached to every successfully authenticated request.
 *
 * H25: every authenticated request MUST carry a non-empty `engineId` and
 * `principal`. The transport layer rejects (HTTP 401) any request for which
 * middleware returns `null` — there is no path to the engine handler without
 * a populated `AuthContext`.
 *
 * `claims` is optional metadata the verifier may attach (e.g. scopes, tenant
 * identifiers). Values are restricted to JSON-scalar types (string | number)
 * to prevent content-bearing objects from entering the auth layer.
 */
export interface AuthContext {
  /** Caller's declared engineId. Frozen after middleware returns. */
  readonly engineId: string;
  /** Human-readable identity of the authenticated principal. */
  readonly principal: string;
  /** Optional additional claims (scopes, tenant ID, etc.) — scalar values only. */
  readonly claims?: Record<string, string | number>;
}

// ---------------------------------------------------------------------------
// AuthMiddleware — pluggable authentication interface
// ---------------------------------------------------------------------------

/**
 * Single-method interface for request authentication.
 *
 * Implementations must:
 * 1. Return a populated `AuthContext` if the request is authenticated.
 * 2. Return `null` if the request should be rejected with HTTP 401.
 * 3. Never throw — surface failures as `null` (rejection) rather than
 *    propagating to the request handler as an unhandled exception.
 * 4. Never read request body content (only `AuthRequest.headers` + `path`).
 *
 * The interface is intentionally minimal to keep the seam small and to allow
 * diverse implementation strategies (API key, JWT, mTLS, OIDC, etc.) without
 * coupling to any specific token format.
 */
export interface AuthMiddleware {
  authenticate(req: AuthRequest): Promise<AuthContext | null>;
}

// ---------------------------------------------------------------------------
// createNoopAuthMiddleware — permits all requests (dev / test)
// ---------------------------------------------------------------------------

/**
 * No-op middleware that accepts every request without validation.
 *
 * Returns a fixed `AuthContext` with `engineId: 'anonymous'` and
 * `principal: 'anonymous'`. Suitable for:
 * - Local development where all requests are trusted
 * - Unit / integration tests that focus on engine behaviour, not auth
 * - Deployments where the network boundary already enforces access control
 *
 * H25 compliance: every request still receives a populated `AuthContext` with
 * a valid `engineId` — the invariant holds even in the no-auth case.
 */
export function createNoopAuthMiddleware(): AuthMiddleware {
  return {
    async authenticate(_req: AuthRequest): Promise<AuthContext> {
      return { engineId: 'anonymous', principal: 'anonymous' };
    },
  };
}

// ---------------------------------------------------------------------------
// createBearerTokenAuthMiddleware — validates Authorization: Bearer <token>
// ---------------------------------------------------------------------------

/**
 * Options for `createBearerTokenAuthMiddleware`.
 *
 * The consumer supplies `verifyToken` — Hoplon never bundles a JWT library or
 * cryptographic key material. The verifier is the integration point between
 * Hoplon's transport layer and the deployment's identity provider.
 */
export interface BearerTokenAuthOptions {
  /**
   * Async token verifier supplied by the consumer.
   *
   * Receives the raw bearer token string (stripped of the "Bearer " prefix).
   * Must return a populated `AuthContext` if valid, or `null` if invalid /
   * expired / malformed.
   *
   * Implementations MUST NOT throw. Thrown errors are caught internally and
   * treated as `null` (rejection) to prevent unhandled promise rejections from
   * bypassing the auth gate.
   */
  verifyToken(token: string): Promise<AuthContext | null>;
}

/**
 * Bearer token auth middleware factory.
 *
 * Extracts the token from the `Authorization: Bearer <token>` header,
 * delegates verification to the consumer's `verifyToken` callback, and
 * returns the resulting `AuthContext` or `null`.
 *
 * Rejection cases (all return `null` → HTTP 401):
 * - Missing `Authorization` header
 * - Header present but does not start with `Bearer ` (case-sensitive)
 * - Token present but `verifyToken` returns `null`
 * - `verifyToken` throws (caught internally; treated as null)
 *
 * H13 compliance: the raw token string is never stored, logged, or included
 * in any error object. It is passed directly to `verifyToken` and discarded.
 *
 * @param opts - Options object containing the `verifyToken` callback.
 */
export function createBearerTokenAuthMiddleware(
  opts: BearerTokenAuthOptions,
): AuthMiddleware {
  return {
    async authenticate(req: AuthRequest): Promise<AuthContext | null> {
      const authHeader = req.headers['authorization'];
      if (!authHeader) {
        return null;
      }

      if (!authHeader.startsWith('Bearer ')) {
        return null;
      }

      const token = authHeader.slice('Bearer '.length);
      if (!token) {
        return null;
      }

      try {
        return await opts.verifyToken(token);
      } catch {
        // H13: do not propagate token content in errors
        return null;
      }
    },
  };
}

// ---------------------------------------------------------------------------
// registerAuthMiddleware — T1 server integration seam
// ---------------------------------------------------------------------------

/**
 * Creates a bound auth middleware registry for use by the HTTP server (T1).
 *
 * Returns two functions:
 * - `registerAuthMiddleware(mw)` — sets the active middleware. May be called
 *   before the server starts accepting requests. Calling it again replaces the
 *   current middleware (one active middleware at a time — H5: one mechanism
 *   per concern).
 * - `runAuth(req)` — executes the currently registered middleware. Returns
 *   `AuthContext` on success, `null` on rejection. The server MUST call this
 *   on every request and MUST respond with HTTP 401 if the result is `null`.
 *
 * T1 integration contract:
 * 1. Construct the registry once: `const auth = createAuthRegistry()`.
 * 2. Optionally call `auth.registerAuthMiddleware(mw)` to swap from the
 *    default (noop) before the server starts.
 * 3. In every route handler (or a Fastify preHandler hook): call
 *    `const ctx = await auth.runAuth(req)` and return 401 if `ctx === null`.
 * 4. Attach `ctx` to the request lifecycle for downstream handlers to read
 *    (H25: engineId available for every authenticated request).
 *
 * Default: `createNoopAuthMiddleware()` — allows all requests through, suitable
 * for in-process / local deployments that do not need transport-layer auth.
 */
export interface AuthRegistry {
  registerAuthMiddleware(mw: AuthMiddleware): void;
  runAuth(req: AuthRequest): Promise<AuthContext | null>;
}

export function createAuthRegistry(): AuthRegistry {
  let active: AuthMiddleware = createNoopAuthMiddleware();

  return {
    registerAuthMiddleware(mw: AuthMiddleware): void {
      active = mw;
    },
    runAuth(req: AuthRequest): Promise<AuthContext | null> {
      return active.authenticate(req);
    },
  };
}
