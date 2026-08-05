import type { SnapshotStore } from '../adapters/snapshotStore.js';
import type { TraceStore } from '../adapters/traceStore.js';
import type { AuthorizationAdapter } from '../authorization/authorizationAdapter.js';
import type {
  ProofAccessAuditSink,
  ProofAccessPolicy,
} from '../contracts/complianceAccess.js';
import type { HoplonEngine } from '../engine/types.js';
import type { EngagementStore } from '../launcher/engagementStore.js';
import type { SessionRegistry } from '../session/registry.js';
import type { AgentToolProfile } from '../transport/agentToolProfile.js';
import type { CapabilityGateDeps } from '../transport/capabilityEngagementGate.js';
import type { PolicyAuditSink } from '../transport/policyAuditSink.js';

export interface McpServerOptions {
  /** The live Hoplon engine instance to wrap. */
  engine: HoplonEngine;
  /** Optional placeholder bearer-token configuration. */
  auth?: { token: string };
  /** Optional registry enabling the packaged `session_*` tools. */
  sessionRegistry?: SessionRegistry;
  /** Optional durable store enabling read-only trace tools. */
  traceStore?: TraceStore;
  /** Optional enterprise proof/export access policy. */
  proofAccess?: {
    policy: ProofAccessPolicy;
    auditSink: ProofAccessAuditSink;
    principalId: string | null;
    engineId: string;
    now?: () => string;
  };
  /** Optional launcher root enabling project tools. */
  launcherRoot?: string;
  /** Optional launcher-root engagement store override. */
  engagementStore?: EngagementStore;
  /** Optional durable policy-audit sink. */
  policyAuditSink?: PolicyAuditSink;
  /** Optional snapshot store enabling policy-audit query tools. */
  snapshotStore?: SnapshotStore;
  /** Optional compatibility or strict-agent tool profile. */
  agentToolProfile?: AgentToolProfile;
  /** Optional authorization adapter for project handshakes. */
  authorizationAdapter?: AuthorizationAdapter;
  /** Optional strict-agent capability enforcement dependencies. */
  capabilityGate?: CapabilityGateDeps;
}
