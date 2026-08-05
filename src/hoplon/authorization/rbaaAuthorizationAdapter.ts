import { randomBytes } from 'node:crypto';

import type {
  AuthorizationAdapter,
  HoplonAuthorizationDecision,
  HoplonAuthorizationRequest,
} from './authorizationAdapter.js';
import {
  RbaaAuthorizationDecisionSchema,
  RbaaAuthorizationRequestSchema,
  type RbaaActiveGrant,
  type RbaaAuthorizationRequest,
  type RbaaRiskFacts,
} from '../contracts/rbaaAuthorization.js';
import {
  type RbaaActiveGrantProvider,
  type RbaaActiveGrantsResult,
  type RbaaAuthorizationClient,
  type RbaaAuthorizationClientResult,
  type RbaaHostProfile,
  type RbaaRiskFactsProvider,
  type RbaaRiskFactsResult,
} from './rbaaAuthorizationClient.js';
import { mapRbaaDecision } from './rbaaDecisionMapper.js';

export interface RbaaAuthorizationAdapterDeps {
  readonly client: RbaaAuthorizationClient;
  readonly hostProfile: RbaaHostProfile;
  readonly riskFactsProvider?: RbaaRiskFactsProvider;
  readonly activeGrantProvider?: RbaaActiveGrantProvider;
  readonly requireActiveGrantsForCapabilities?: ReadonlyArray<
    'read' | 'search' | 'write' | 'lock' | 'snapshot'
  >;
  readonly engineName?: string;
  readonly generateDecisionId?: () => string;
}

export class RbaaAuthorizationAdapter implements AuthorizationAdapter {
  private readonly client: RbaaAuthorizationClient;
  private readonly hostProfile: RbaaHostProfile;
  private readonly riskFactsProvider: RbaaRiskFactsProvider | undefined;
  private readonly activeGrantProvider: RbaaActiveGrantProvider | undefined;
  private readonly requireActiveGrantsFor: ReadonlySet<
    'read' | 'search' | 'write' | 'lock' | 'snapshot'
  >;
  private readonly engineName: string;
  private readonly generateDecisionId: () => string;

  constructor(deps: RbaaAuthorizationAdapterDeps) {
    this.client = deps.client;
    this.hostProfile = deps.hostProfile;
    this.riskFactsProvider = deps.riskFactsProvider;
    this.activeGrantProvider = deps.activeGrantProvider;
    this.requireActiveGrantsFor = new Set(
      deps.requireActiveGrantsForCapabilities ?? ['write', 'lock', 'snapshot'],
    );
    this.engineName = deps.engineName ?? 'rbaa';
    this.generateDecisionId =
      deps.generateDecisionId ??
      (() => `${this.engineName}-adapter-${randomBytes(8).toString('hex')}`);
  }

  async evaluateAccess(
    request: HoplonAuthorizationRequest,
  ): Promise<HoplonAuthorizationDecision> {
    const facts = await this.resolveRiskFacts(request);
    if (facts.kind === 'unavailable') {
      return this.buildDeny(`rbaa_risk_facts_unavailable: ${facts.reason}`);
    }

    const grants = await this.resolveActiveGrants(request);
    if (grants.kind === 'unavailable') {
      return this.buildDeny(`rbaa_active_grants_unavailable: ${grants.reason}`);
    }

    const rbaaRequest = this.buildRbaaRequest(request, facts.riskFacts, grants);
    const parsedRequest = RbaaAuthorizationRequestSchema.safeParse(rbaaRequest);
    if (!parsedRequest.success) {
      return this.buildDeny(
        `rbaa_request_malformed: ${formatSchemaIssue(parsedRequest.error)}`,
      );
    }

    const clientResult = await this.evaluateClient(parsedRequest.data);
    if (clientResult.kind === 'error') {
      return this.buildDeny(`rbaa_client_unavailable: ${clientResult.reason}`);
    }

    const parsedDecision = RbaaAuthorizationDecisionSchema.safeParse(
      clientResult.rawDecision,
    );
    if (!parsedDecision.success) {
      return this.buildDeny(
        `rbaa_malformed_decision: ${formatSchemaIssue(parsedDecision.error)}`,
      );
    }
    return mapRbaaDecision(parsedDecision.data, (reason) =>
      this.buildDeny(reason),
    );
  }

  private async resolveRiskFacts(
    request: HoplonAuthorizationRequest,
  ): Promise<RbaaRiskFactsResult> {
    if (this.riskFactsProvider === undefined) {
      return {
        kind: 'ok',
        riskFacts: buildBaselineRiskFacts(request, this.hostProfile),
      };
    }
    try {
      return await this.riskFactsProvider.buildRiskFacts(
        request,
        this.hostProfile,
      );
    } catch (err) {
      return { kind: 'unavailable', reason: `threw: ${describeThrown(err)}` };
    }
  }

  private async resolveActiveGrants(
    request: HoplonAuthorizationRequest,
  ): Promise<{ kind: 'ok'; activeGrants?: RbaaActiveGrant[] } | RbaaActiveGrantsResult> {
    if (this.activeGrantProvider === undefined) return { kind: 'ok' };
    let result: RbaaActiveGrantsResult;
    try {
      result = await this.activeGrantProvider.listActiveGrants(request);
    } catch (err) {
      result = { kind: 'unavailable', reason: `threw: ${describeThrown(err)}` };
    }
    if (result.kind === 'ok') return result;
    const required = request.request.capabilities.some((capability) =>
      this.requireActiveGrantsFor.has(capability),
    );
    return required ? result : { kind: 'ok', activeGrants: [] };
  }

  private buildRbaaRequest(
    request: HoplonAuthorizationRequest,
    riskFacts: RbaaRiskFacts,
    grants: { kind: 'ok'; activeGrants?: RbaaActiveGrant[] },
  ): unknown {
    return {
      schemaVersion: 1,
      principal: request.principal,
      task: {
        id: request.task.id,
        ...(request.task.type !== undefined ? { type: request.task.type } : {}),
        ...(request.task.delegationChain !== undefined
          ? { delegationChain: [...request.task.delegationChain] }
          : {}),
      },
      request: {
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
      },
      context: request.context,
      riskFacts,
      ...(grants.activeGrants !== undefined
        ? { activeGrants: [...grants.activeGrants] }
        : {}),
    };
  }

  private async evaluateClient(
    request: RbaaAuthorizationRequest,
  ): Promise<RbaaAuthorizationClientResult> {
    try {
      return await this.client.evaluateAuthorization(request);
    } catch (err) {
      return { kind: 'error', reason: `threw: ${describeThrown(err)}` };
    }
  }

  private buildDeny(reason: string): HoplonAuthorizationDecision {
    return {
      outcome: 'deny',
      reason,
      decisionId: this.generateDecisionId(),
      policyVersion: `${this.engineName}-adapter-error`,
    };
  }
}

function buildBaselineRiskFacts(
  request: HoplonAuthorizationRequest,
  hostProfile: RbaaHostProfile,
): RbaaRiskFacts {
  return {
    projectId: request.request.projectId,
    branch: request.request.branch,
    sessionId: request.context.sessionId,
    evaluatedAt: request.context.now,
    facts: [
      {
        id: `baseline-${hostProfile}`,
        source: 'hoplon',
        label: `baseline risk facts for ${hostProfile}`,
        severity: riskLevelToSeverity(request.task.riskLevel),
      },
    ],
  };
}

function riskLevelToSeverity(
  riskLevel: HoplonAuthorizationRequest['task']['riskLevel'],
): 'info' | 'low' | 'medium' | 'high' | 'critical' {
  if (riskLevel === 'low') return 'low';
  if (riskLevel === 'medium') return 'medium';
  if (riskLevel === 'high') return 'high';
  return 'info';
}

function formatSchemaIssue(error: {
  issues: Array<{ path: PropertyKey[]; message: string }>;
}): string {
  const issue = error.issues[0];
  if (issue === undefined) return 'unknown schema error';
  const path = issue.path.length > 0 ? issue.path.join('.') : 'root';
  return `${path}: ${issue.message}`;
}

function describeThrown(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
