/**
 * authorization/opaAuthorizationAdapter.ts — dynamic OPA-driven
 * implementation of `AuthorizationAdapter` (T-145).
 *
 * Advisory-only build: this adapter is NOT wired as the default runtime
 * adapter. The handshake layer continues to use
 * `StaticAuthorizationAdapter` until T-146 introduces an explicit
 * static-vs-dynamic selection seam.
 *
 * Responsibilities (per `docs/THREAT_MODEL.md` and the OPA sidecar
 * Integration"):
 *   1. Validate the incoming request has the minimum required fields.
 *   2. Fetch active grants via the injected `ActiveGrantClient`. Agent-
 *      supplied grant ids in the request are ignored: only the client's
 *      output is forwarded into OPA input.
 *   3. Build the OPA input document: principal, task, request, context
 *      (with `now` set from `clock.nowIso()` exactly once), and the
 *      `activeGrants` array.
 *   4. Call `opaClient.evaluate(decisionPath, input)`.
 *   5. Normalize the raw OPA decision through `normalizeOpaDecision`.
 *   6. Fail closed on every error path: OPA unavailable, malformed
 *      decision, required grants unavailable. Failures return a typed
 *      `deny` decision; the adapter never throws.
 *
 * Architecture rules:
 *   - No `fetch`, `http`, `node:net`, or environment reads.
 *   - All side effects (network, time, randomness) injected via the
 *     constructor. The adapter is a pure transformer otherwise.
 *   - 300-line file limit honored; helpers split out where useful.
 *   - Named exports only. TypeScript strict. No `any`.
 */
import { randomBytes } from 'node:crypto';

import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from './authorizationAdapter.js';
import type {
  ActiveGrant,
  ActiveGrantClient,
} from './activeGrantClient.js';
import type { Clock } from './clock.js';
import type { OpaClient } from './opaClient.js';
import { normalizeOpaDecision } from './normalizeOpaDecision.js';

/** Default OPA decision path used by the Hoplon policy bundle. */
export const DEFAULT_OPA_DECISION_PATH = '/v1/data/hoplon/authz/decision';

/** Default engine name embedded in `PolicyEvidence` for tokens minted on top of this decision. */
export const DEFAULT_OPA_ENGINE_NAME = 'opa';

/**
 * Capabilities that, by default, require an active-grant lookup to
 * succeed before OPA can be consulted. Read/search are intentionally
 * absent: baseline access can be evaluated even if the Control Plane
 * is unreachable.
 */
export const DEFAULT_GRANT_REQUIRED_CAPABILITIES: ReadonlyArray<
  'read' | 'search' | 'write' | 'lock' | 'snapshot'
> = ['write', 'lock'] as const;

/**
 * Constructor dependencies for `OpaAuthorizationAdapter`. All fields are
 * injected; the adapter must not reach beyond this interface.
 */
export interface OpaAuthorizationAdapterDeps {
  readonly opaClient: OpaClient;
  readonly grantClient: ActiveGrantClient;
  readonly clock: Clock;
  /** Defaults to {@link DEFAULT_OPA_DECISION_PATH}. */
  readonly decisionPath?: string;
  /** Defaults to {@link DEFAULT_OPA_ENGINE_NAME}. */
  readonly engineName?: string;
  /** Defaults to {@link DEFAULT_GRANT_REQUIRED_CAPABILITIES}. */
  readonly requireGrantsForCapabilities?: ReadonlyArray<
    'read' | 'search' | 'write' | 'lock' | 'snapshot'
  >;
  /**
   * Override decision id generation for failure cases (where OPA never
   * produced a decision id). Useful for deterministic tests.
   */
  readonly generateDecisionId?: () => string;
}

/**
 * Dynamic OPA-driven authorization adapter. Advisory-only: not wired as
 * the default runtime adapter (see T-146).
 */
export class OpaAuthorizationAdapter implements AuthorizationAdapter {
  private readonly opaClient: OpaClient;
  private readonly grantClient: ActiveGrantClient;
  private readonly clock: Clock;
  private readonly decisionPath: string;
  private readonly engineName: string;
  private readonly requireGrantsFor: ReadonlySet<
    'read' | 'search' | 'write' | 'lock' | 'snapshot'
  >;
  private readonly generateDecisionId: () => string;

  constructor(deps: OpaAuthorizationAdapterDeps) {
    this.opaClient = deps.opaClient;
    this.grantClient = deps.grantClient;
    this.clock = deps.clock;
    this.decisionPath = deps.decisionPath ?? DEFAULT_OPA_DECISION_PATH;
    this.engineName = deps.engineName ?? DEFAULT_OPA_ENGINE_NAME;
    this.requireGrantsFor = new Set(
      deps.requireGrantsForCapabilities ?? DEFAULT_GRANT_REQUIRED_CAPABILITIES,
    );
    this.generateDecisionId =
      deps.generateDecisionId ??
      (() => `${this.engineName}-adapter-${randomBytes(8).toString('hex')}`);
  }

  /** The engine name embedded in adapter-emitted `deny` decisions. */
  public get engine(): string {
    return this.engineName;
  }

  /**
   * Evaluate access. Never throws. Each call is independent: clock and
   * grant client are read at most once per call, and no shared mutable
   * state is captured between concurrent invocations.
   */
  async evaluateAccess(
    request: HoplonAuthorizationRequest,
  ): Promise<HoplonAuthorizationDecision> {
    // Step 1: defensive request validation — mirror StaticAuthorizationAdapter.
    const requestError = validateRequestShape(request);
    if (requestError !== null) {
      return this.buildDeny(`adapter_request_invalid: ${requestError}`);
    }

    // Step 2: snapshot the clock once at the start of evaluateAccess. Even if
    // wall time advances during sidecar I/O, the same `now` is used in OPA
    // input, in any deny decisions emitted from this call, and in any audit
    // record the caller derives.
    let nowIso: string;
    try {
      nowIso = this.clock.nowIso();
    } catch (err) {
      return this.buildDeny(`clock_unavailable: ${describeThrown(err)}`);
    }

    // Step 3: fetch active grants from the Control Plane. Agent-supplied
    // grant ids in `request` are deliberately ignored — only this client's
    // output is forwarded into OPA input.
    const grantResult = await this.listActiveGrants(request);

    let activeGrants: ActiveGrant[];
    if (grantResult.kind === 'ok') {
      activeGrants = grantResult.grants;
    } else {
      const requiresGrants = request.request.capabilities.some((c) =>
        this.requireGrantsFor.has(c),
      );
      if (requiresGrants) {
        return this.buildDeny(
          `grant_lookup_unavailable_for_required_capability: ${grantResult.reason}`,
        );
      }
      activeGrants = [];
    }

    // Step 4: build OPA input. We reconstruct the document explicitly
    // (rather than spreading `request`) so future fields added to
    // `HoplonAuthorizationRequest` do not silently leak into OPA input
    // without an audit/policy review.
    const opaInput = {
      principal: request.principal,
      task: request.task,
      request: sanitizeRequestForOpa(request),
      context: { ...request.context, now: nowIso },
      activeGrants,
    };

    const opaResult = await this.evaluateOpa(opaInput);
    if (opaResult.kind === 'error') {
      return this.buildDeny(`opa_unavailable: ${opaResult.reason}`);
    }

    // Step 6: normalize. Malformed → typed deny.
    const normalized = normalizeOpaDecision(opaResult.raw);
    if (normalized.kind === 'malformed') {
      return this.buildDeny(
        `opa_malformed_decision: ${normalized.field}: ${normalized.reason}`,
      );
    }
    return normalized.decision;
  }

  /** Build an adapter-emitted `deny` decision. */
  private buildDeny(reason: string): HoplonAuthorizationDecision {
    return {
      outcome: 'deny',
      reason,
      decisionId: this.generateDecisionId(),
      policyVersion: `${this.engineName}-adapter-error`,
    };
  }

  private async listActiveGrants(
    request: HoplonAuthorizationRequest,
  ): Promise<Awaited<ReturnType<ActiveGrantClient['listActiveGrants']>>> {
    try {
      return await this.grantClient.listActiveGrants({
        principalId: request.principal.id,
        taskId: request.task.id,
        projectId: request.request.projectId,
      });
    } catch (err) {
      return {
        kind: 'unavailable',
        reason: `threw: ${describeThrown(err)}`,
      };
    }
  }

  private async evaluateOpa(
    opaInput: unknown,
  ): Promise<Awaited<ReturnType<OpaClient['evaluate']>>> {
    try {
      return await this.opaClient.evaluate(this.decisionPath, opaInput);
    } catch (err) {
      return {
        kind: 'error',
        reason: `threw: ${describeThrown(err)}`,
      };
    }
  }
}

function sanitizeRequestForOpa(request: HoplonAuthorizationRequest) {
  return {
    projectId: request.request.projectId,
    branch: request.request.branch,
    capabilities: [...request.request.capabilities],
    ...(request.request.paths !== undefined
      ? { paths: [...request.request.paths] }
      : {}),
    ...(request.request.astSelectors !== undefined
      ? { astSelectors: [...request.request.astSelectors] }
      : {}),
    ...(request.request.astNodeIds !== undefined
      ? { astNodeIds: [...request.request.astNodeIds] }
      : {}),
    ...(request.request.reason !== undefined
      ? { reason: request.request.reason }
      : {}),
  };
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Defensive request validation. Returns `null` on success or a short
 * descriptive string on failure. Keeps the adapter from making OPA/grant
 * calls with obviously invalid input.
 */
function validateRequestShape(
  request: HoplonAuthorizationRequest,
): string | null {
  if (
    typeof request.principal?.id !== 'string' ||
    request.principal.id.length === 0
  ) {
    return 'missing principal.id';
  }
  if (typeof request.task?.id !== 'string' || request.task.id.length === 0) {
    return 'missing task.id';
  }
  if (
    typeof request.request?.projectId !== 'string' ||
    request.request.projectId.length === 0
  ) {
    return 'missing request.projectId';
  }
  if (
    typeof request.request?.branch !== 'string' ||
    request.request.branch.length === 0
  ) {
    return 'missing request.branch';
  }
  if (
    !Array.isArray(request.request?.capabilities) ||
    request.request.capabilities.length === 0
  ) {
    return 'request.capabilities must be a non-empty array';
  }
  if (
    typeof request.context?.sessionId !== 'string' ||
    request.context.sessionId.length === 0
  ) {
    return 'missing context.sessionId';
  }
  return null;
}
