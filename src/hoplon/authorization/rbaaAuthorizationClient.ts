import type { OpaClient } from './opaClient.js';
import type { HoplonAuthorizationRequest } from './authorizationAdapter.js';
import type {
  RbaaActiveGrant,
  RbaaAuthorizationRequest,
  RbaaRiskFacts,
} from '../contracts/rbaaAuthorization.js';

export const RBAA_HOST_PROFILES = [
  'direct_llm',
  'phalanx_limited_controls',
  'agentic_os_control_plane',
] as const;
export type RbaaHostProfile = (typeof RBAA_HOST_PROFILES)[number];

export const DEFAULT_RBAA_OPA_DECISION_PATH =
  '/v1/data/hoplon/rbaa/v1/decision';

export type RbaaAuthorizationClientResult =
  | { kind: 'ok'; rawDecision: unknown }
  | { kind: 'error'; reason: string };

export interface RbaaAuthorizationClient {
  evaluateAuthorization(
    request: RbaaAuthorizationRequest,
  ): Promise<RbaaAuthorizationClientResult>;
}

export type RbaaRiskFactsResult =
  | { kind: 'ok'; riskFacts: RbaaRiskFacts }
  | { kind: 'unavailable'; reason: string };

export interface RbaaRiskFactsProvider {
  buildRiskFacts(
    request: HoplonAuthorizationRequest,
    hostProfile: RbaaHostProfile,
  ): Promise<RbaaRiskFactsResult>;
}

export type RbaaActiveGrantsResult =
  | { kind: 'ok'; activeGrants: RbaaActiveGrant[] }
  | { kind: 'unavailable'; reason: string };

export interface RbaaActiveGrantProvider {
  listActiveGrants(
    request: HoplonAuthorizationRequest,
  ): Promise<RbaaActiveGrantsResult>;
}

export interface RbaaOpaAuthorizationClientDeps {
  readonly opaClient: OpaClient;
  readonly decisionPath?: string;
}

export class RbaaOpaAuthorizationClient implements RbaaAuthorizationClient {
  private readonly opaClient: OpaClient;
  private readonly decisionPath: string;

  constructor(deps: RbaaOpaAuthorizationClientDeps) {
    this.opaClient = deps.opaClient;
    this.decisionPath = deps.decisionPath ?? DEFAULT_RBAA_OPA_DECISION_PATH;
  }

  async evaluateAuthorization(
    request: RbaaAuthorizationRequest,
  ): Promise<RbaaAuthorizationClientResult> {
    const result = await this.opaClient.evaluate(this.decisionPath, request);
    if (result.kind === 'error') {
      return { kind: 'error', reason: result.reason };
    }
    return { kind: 'ok', rawDecision: result.raw };
  }
}
