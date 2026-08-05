/** Fastify transport for the Hoplon engine and optional packaged surfaces. */

import type { FastifyInstance } from 'fastify';
import fastifyFactory = require('fastify');

import { openEngagementStore } from '../../launcher/engagementStore.js';
import {
  normalizeAgentToolProfile,
  STRICT_AGENT_TOOL_PROFILE,
} from '../agentToolProfile.js';
import { createEngineDispatcher } from '../dispatcher.js';
import type { EngineDispatcher } from '../dispatcher.js';
import { createPolicyAuditSink } from '../policyAuditSink.js';
import type { PolicyAuditSink } from '../policyAuditSink.js';
import { createProjectAwareDispatcher } from '../projectResolver.js';
import type { StrictEngagementGateDeps } from '../strictEngagementGate.js';
import { registerProjectsHttpRoutes } from './projectsRoutes.js';
import { toHttpErrorEnvelope } from './serverErrors.js';
import { registerEngineHttpRoutes } from './serverEngineRoutes.js';
import type { HoplonHttpServerOptions } from './serverOptions.js';
import { assertHostAuthPolicy, registerHttpAuthHook } from './serverAuth.js';
import { registerSessionHttpRoutes } from './sessionRoutes.js';
import { registerStrictAgentFallbackNotFound } from './strictAgentFallbackRoutes.js';
import { registerTraceHttpRoutes } from './traceRoutes.js';

export type { HoplonHttpServerOptions } from './serverOptions.js';

export async function createHoplonHttpServer(
  opts: HoplonHttpServerOptions,
): Promise<FastifyInstance> {
  const server: FastifyInstance = opts.fastify ?? fastifyFactory({ logger: false });
  assertHostAuthPolicy({
    host: opts.host,
    authConfigured: opts.authRegistry !== undefined,
    allowUnauthenticated: opts.allowUnauthenticated === true,
  });
  if (opts.authRegistry !== undefined) {
    registerHttpAuthHook(server, opts.authRegistry);
  }

  const strictProfile =
    normalizeAgentToolProfile(opts.agentToolProfile) === STRICT_AGENT_TOOL_PROFILE;
  const engagementStore =
    opts.engagementStore ??
    (opts.launcherRoot ? openEngagementStore(opts.launcherRoot) : undefined);
  const policyAuditSink: PolicyAuditSink | undefined =
    opts.policyAuditSink ??
    (strictProfile && opts.snapshotStore
      ? createPolicyAuditSink({
          store: opts.snapshotStore,
          engineId: 'http-server',
          ...(opts.emitter !== undefined ? { emitter: opts.emitter } : {}),
        })
      : undefined);
  const strictEngagementGate: StrictEngagementGateDeps | undefined = strictProfile
    ? {
        ...(engagementStore !== undefined ? { store: engagementStore } : {}),
        ...(policyAuditSink !== undefined ? { sink: policyAuditSink } : {}),
        ...(opts.capabilityGate !== undefined
          ? { capability: opts.capabilityGate }
          : {}),
        engineId: 'http-server',
      }
    : undefined;

  if (strictProfile) registerStrictAgentFallbackNotFound(server);
  const dispatcher: EngineDispatcher = opts.projectRouter
    ? createProjectAwareDispatcher({
        defaultEngine: opts.engine,
        router: opts.projectRouter,
      })
    : createEngineDispatcher(opts.engine);

  registerEngineHttpRoutes({
    server,
    dispatcher,
    ...(opts.agentToolProfile !== undefined
      ? { agentToolProfile: opts.agentToolProfile }
      : {}),
    ...(strictEngagementGate !== undefined ? { strictEngagementGate } : {}),
  });

  if (opts.sessionRegistry) {
    registerSessionHttpRoutes({
      server,
      registry: opts.sessionRegistry,
      toEngineErrorEnvelope: toHttpErrorEnvelope,
      ...(opts.agentToolProfile !== undefined
        ? { agentToolProfile: opts.agentToolProfile }
        : {}),
      ...(strictEngagementGate !== undefined ? { strictEngagementGate } : {}),
    });
  }
  if (opts.traceStore) {
    registerTraceHttpRoutes({
      server,
      traceStore: opts.traceStore,
      ...(opts.proofAccess !== undefined
        ? { enterpriseAccess: opts.proofAccess }
        : {}),
      toEngineErrorEnvelope: toHttpErrorEnvelope,
    });
  }
  if (opts.launcherRoot) {
    registerProjectsHttpRoutes({
      server,
      launcherRoot: opts.launcherRoot,
      ...(engagementStore !== undefined ? { engagementStore } : {}),
      ...(policyAuditSink !== undefined ? { policyAuditSink } : {}),
      ...(opts.snapshotStore !== undefined
        ? { snapshotStore: opts.snapshotStore }
        : {}),
      ...(opts.agentToolProfile !== undefined
        ? { agentToolProfile: opts.agentToolProfile }
        : {}),
      ...(opts.authorizationAdapter !== undefined
        ? { authorizationAdapter: opts.authorizationAdapter }
        : {}),
    });
  }

  await server.ready();
  return server;
}
