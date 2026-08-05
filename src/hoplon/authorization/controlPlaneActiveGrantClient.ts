/**
 * authorization/controlPlaneActiveGrantClient.ts — HTTP implementation of
 * ActiveGrantClient for the Agentic OS Control Plane active-grant lookup.
 *
 * This is an opt-in host-injected client. It does not change Hoplon's
 * default StaticAuthorizationAdapter path.
 */
import { z } from 'zod';

import type {
  ActiveGrant,
  ActiveGrantClient,
  ListActiveGrantsRequest,
  ListActiveGrantsResult,
} from './activeGrantClient.js';
import type {
  ScopeClaim,
  TokenCapabilities,
} from './authorizationAdapter.js';

type FetchFn = typeof globalThis.fetch;

export interface ControlPlaneActiveGrantClientDeps {
  readonly baseUrl: string;
  readonly authorization: string;
  readonly serviceId: string;
  readonly traceId: string | (() => string);
  readonly fetchImpl?: FetchFn;
  readonly path?: string;
}

const DEFAULT_ACTIVE_GRANTS_PATH = '/control-plane/escalation-grants/active';

const ScopeClaimSchema = z
  .object({
    paths: z.array(z.string().min(1)).min(1),
    branches: z.array(z.string().min(1)).min(1),
    deniedPaths: z.array(z.string().min(1)).optional(),
    astNodeIds: z.array(z.string().min(1)).optional(),
    astSelectors: z.array(z.string().min(1)).optional(),
    maxOperations: z.number().int().positive().optional(),
    maxFilesTouched: z.number().int().positive().optional(),
  })
  .strict();

const TokenCapabilitiesSchema = z
  .object({
    read: ScopeClaimSchema.optional(),
    search: ScopeClaimSchema.optional(),
    write: ScopeClaimSchema.optional(),
    lock: ScopeClaimSchema.optional(),
    snapshot: ScopeClaimSchema.optional(),
  })
  .strict()
  .refine((scope) => Object.values(scope).some((value) => value !== undefined), {
    message: 'grant scope must contain at least one capability',
  });

const ActiveGrantSchema = z
  .object({
    grantId: z.string().min(1),
    escalationRequestId: z.string().min(1).optional(),
    status: z.string().min(1).optional(),
    principalId: z.string().min(1),
    taskId: z.string().min(1),
    projectId: z.string().min(1),
    scope: TokenCapabilitiesSchema,
    expiresAt: z.string().datetime(),
  })
  .strict();

const ActiveGrantsDataSchema = z
  .object({
    activeGrants: z.array(ActiveGrantSchema),
  })
  .strict();

const ApiErrorSchema = z
  .object({
    code: z.string().optional(),
    message: z.string().min(1),
  })
  .passthrough();

const ActiveGrantsEnvelopeSchema = z.discriminatedUnion('ok', [
  z
    .object({
      ok: z.literal(true),
      data: ActiveGrantsDataSchema,
      traceId: z.string().min(1),
    })
    .passthrough(),
  z
    .object({
      ok: z.literal(false),
      error: ApiErrorSchema,
      traceId: z.string().min(1),
    })
    .passthrough(),
]);

export class ControlPlaneActiveGrantClient implements ActiveGrantClient {
  private readonly baseUrl: string;
  private readonly authorization: string;
  private readonly serviceId: string;
  private readonly traceId: string | (() => string);
  private readonly fetchImpl: FetchFn | undefined;
  private readonly path: string;

  constructor(deps: ControlPlaneActiveGrantClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.authorization = deps.authorization;
    this.serviceId = deps.serviceId;
    this.traceId = deps.traceId;
    this.fetchImpl = deps.fetchImpl;
    this.path = deps.path ?? DEFAULT_ACTIVE_GRANTS_PATH;
  }

  async listActiveGrants(
    req: ListActiveGrantsRequest,
  ): Promise<ListActiveGrantsResult> {
    const url = new URL(this.path, this.baseUrl);
    url.searchParams.set('principalId', req.principalId);
    url.searchParams.set('taskId', req.taskId);
    url.searchParams.set('projectId', req.projectId);

    let response: Response;
    try {
      response = await (this.fetchImpl ?? globalThis.fetch)(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          authorization: this.authorization,
          'x-hoplon-service-id': this.serviceId,
          'x-trace-id': this.resolveTraceId(),
        },
      });
    } catch (err) {
      return unavailable(`network_error: ${describeError(err)}`);
    }

    const raw = await readText(response);
    if (raw.kind === 'unavailable') return raw;
    const parsedJson = parseJson(raw.text);
    if (parsedJson.kind === 'unavailable') return parsedJson;

    const parsedEnvelope = ActiveGrantsEnvelopeSchema.safeParse(parsedJson.value);
    if (!parsedEnvelope.success) {
      return unavailable(`malformed_response: ${parsedEnvelope.error.message}`);
    }
    if (!parsedEnvelope.data.ok) {
      return unavailable(
        `control_plane_error:${response.status}:${parsedEnvelope.data.error.message}`,
      );
    }
    if (!response.ok) {
      return unavailable(`http_${String(response.status)}_with_ok_envelope`);
    }
    return {
      kind: 'ok',
      grants: parsedEnvelope.data.data.activeGrants.map(toActiveGrant),
    };
  }

  private resolveTraceId(): string {
    return typeof this.traceId === 'function' ? this.traceId() : this.traceId;
  }
}

type ParsedActiveGrant = z.infer<typeof ActiveGrantSchema>;

function toActiveGrant(grant: ParsedActiveGrant): ActiveGrant {
  return {
    grantId: grant.grantId,
    ...(grant.escalationRequestId !== undefined
      ? { escalationRequestId: grant.escalationRequestId }
      : {}),
    ...(grant.status !== undefined ? { status: grant.status } : {}),
    principalId: grant.principalId,
    taskId: grant.taskId,
    projectId: grant.projectId,
    scope: toTokenCapabilities(grant.scope),
    expiresAt: grant.expiresAt,
  };
}

type ParsedScope = ParsedActiveGrant['scope'];
type ParsedScopeClaim = NonNullable<ParsedScope['read']>;

function toTokenCapabilities(scope: ParsedScope): TokenCapabilities {
  return {
    ...(scope.read !== undefined ? { read: toScopeClaim(scope.read) } : {}),
    ...(scope.search !== undefined ? { search: toScopeClaim(scope.search) } : {}),
    ...(scope.write !== undefined ? { write: toScopeClaim(scope.write) } : {}),
    ...(scope.lock !== undefined ? { lock: toScopeClaim(scope.lock) } : {}),
    ...(scope.snapshot !== undefined
      ? { snapshot: toScopeClaim(scope.snapshot) }
      : {}),
  };
}

function toScopeClaim(claim: ParsedScopeClaim): ScopeClaim {
  return {
    paths: claim.paths,
    branches: claim.branches,
    ...(claim.deniedPaths !== undefined ? { deniedPaths: claim.deniedPaths } : {}),
    ...(claim.astNodeIds !== undefined ? { astNodeIds: claim.astNodeIds } : {}),
    ...(claim.astSelectors !== undefined
      ? { astSelectors: claim.astSelectors }
      : {}),
    ...(claim.maxOperations !== undefined
      ? { maxOperations: claim.maxOperations }
      : {}),
    ...(claim.maxFilesTouched !== undefined
      ? { maxFilesTouched: claim.maxFilesTouched }
      : {}),
  };
}

async function readText(
  response: Response,
): Promise<{ kind: 'ok'; text: string } | { kind: 'unavailable'; reason: string }> {
  try {
    return { kind: 'ok', text: await response.text() };
  } catch (err) {
    return unavailable(`body_read_failed: ${describeError(err)}`);
  }
}

function parseJson(
  raw: string,
): { kind: 'ok'; value: unknown } | { kind: 'unavailable'; reason: string } {
  try {
    return { kind: 'ok', value: JSON.parse(raw) as unknown };
  } catch (err) {
    return unavailable(`json_parse_failed: ${describeError(err)}`);
  }
}

function unavailable(reason: string): { kind: 'unavailable'; reason: string } {
  return { kind: 'unavailable', reason };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
