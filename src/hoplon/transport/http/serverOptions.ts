import type { FastifyInstance, FastifyRequest } from 'fastify';

import type { SnapshotStore } from '../../adapters/snapshotStore.js';
import type { HoplonEmitter } from '../../adapters/emitter.js';
import type { TraceStore } from '../../adapters/traceStore.js';
import type { AuthorizationAdapter } from '../../authorization/authorizationAdapter.js';
import type { HoplonEngineRouter } from '../../concurrency/engineRouter.js';
import type { ProofAccessAuditSink, ProofAccessPolicy } from '../../contracts/complianceAccess.js';
import type { HoplonEngine } from '../../engine/types.js';
import type { EngagementStore } from '../../launcher/engagementStore.js';
import type { SessionRegistry } from '../../session/registry.js';
import type { AgentToolProfile } from '../agentToolProfile.js';
import type { CapabilityGateDeps } from '../capabilityEngagementGate.js';
import type { PolicyAuditSink } from '../policyAuditSink.js';
import type { AuthContext, AuthRegistry } from './auth.js';

export interface HoplonHttpServerOptions {
  engine: HoplonEngine;
  fastify?: FastifyInstance;
  sessionRegistry?: SessionRegistry;
  traceStore?: TraceStore;
  proofAccess?: {
    policy: ProofAccessPolicy;
    auditSink: ProofAccessAuditSink;
    getAuthContext?: (req: FastifyRequest) =>
      | AuthContext
      | null
      | Promise<AuthContext | null>;
    now?: () => string;
  };
  projectRouter?: HoplonEngineRouter;
  launcherRoot?: string;
  engagementStore?: EngagementStore;
  policyAuditSink?: PolicyAuditSink;
  emitter?: HoplonEmitter;
  snapshotStore?: SnapshotStore;
  agentToolProfile?: AgentToolProfile;
  authorizationAdapter?: AuthorizationAdapter;
  capabilityGate?: CapabilityGateDeps;
  authRegistry?: AuthRegistry;
  host?: string;
  allowUnauthenticated?: boolean;
}
