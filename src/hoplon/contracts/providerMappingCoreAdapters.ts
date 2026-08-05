/**
 * providerMappingCoreAdapters.ts — core-adapter ecosystem entries (t-047).
 *
 * Covers ecosystems that bind against a core adapter rather than a capability
 * in `CapabilityIdSchema`: observability (Emitter), lock/coordination
 * (LockProvider), and snapshot-registry/audit storage (SnapshotStore). No
 * capability DTO is overclaimed for these seams.
 */

import type {
  CapabilityDataAccessEntry,
  CapabilityFailureIsolation,
  CapabilityInvocationMode,
  CapabilityRuntimeState,
  CapabilitySideEffectPosture,
} from './capabilities.js';
import type {
  ProviderMappingCoreAdapter,
  ProviderMappingEntry,
} from './providerMapping.js';

type CoreAdapterEntryInit = {
  ecosystem: string;
  ecosystemName: string;
  candidateTools: string[];
  coreAdapter: ProviderMappingCoreAdapter;
  runtimeState: CapabilityRuntimeState;
  invocationMode: CapabilityInvocationMode;
  sideEffectPosture: CapabilitySideEffectPosture;
  failureIsolation: CapabilityFailureIsolation;
  dataAccess: CapabilityDataAccessEntry[];
  notes: string;
};

function coreAdapterEntry(init: CoreAdapterEntryInit): ProviderMappingEntry {
  return { mappingSchemaVersion: 1, seamKind: 'core_adapter', ...init };
}

export const PROVIDER_MAPPING_CORE_ADAPTERS: ProviderMappingEntry[] = [
  coreAdapterEntry({
    ecosystem: 'observability',
    ecosystemName: 'Observability / telemetry',
    candidateTools: ['OpenTelemetry', 'Prometheus', 'Datadog', 'Honeycomb'],
    coreAdapter: 'emitter',
    runtimeState: 'seam_only',
    invocationMode: 'host_invoked',
    sideEffectPosture: 'export_only',
    failureIsolation: 'advisory_only',
    dataAccess: [
      { dataClass: 'audit_evidence', access: 'read_only' },
      { dataClass: 'workspace_metadata', access: 'read_only' },
    ],
    notes:
      'Observability backends bind through the Emitter adapter. Defaults are the noop / console / memory emitters shipped today. OpenTelemetry and similar exporters bind at engine construction; emitter failures must not fail core operations.',
  }),
  coreAdapterEntry({
    ecosystem: 'lock_coordination',
    ecosystemName: 'Lock / coordination',
    candidateTools: [
      'async-mutex (shipped default)',
      'Redlock (Redis)',
      'Postgres advisory locks',
      'ZooKeeper / etcd',
    ],
    coreAdapter: 'lockProvider',
    runtimeState: 'shipped',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'none',
    failureIsolation: 'core_operation',
    dataAccess: [{ dataClass: 'workspace_metadata', access: 'read_only' }],
    notes:
      'Local async-mutex is the shipped default. Redlock, Postgres advisory locks, and ZooKeeper bind through the LockProvider adapter for multi-process self-hosting. Lock acquisition failure fails the current operation by design.',
  }),
  coreAdapterEntry({
    ecosystem: 'snapshot_registry_storage',
    ecosystemName: 'Snapshot registry / audit storage',
    candidateTools: [
      'SQLite (shipped default)',
      'Postgres snapshot store (shipped provider package)',
      'MySQL / MariaDB',
      'CockroachDB',
    ],
    coreAdapter: 'snapshotStore',
    runtimeState: 'shipped',
    invocationMode: 'typed_engine_method',
    sideEffectPosture: 'export_only',
    failureIsolation: 'core_operation',
    dataAccess: [
      { dataClass: 'snapshot_metadata', access: 'read_only' },
      { dataClass: 'audit_evidence', access: 'read_only' },
    ],
    notes:
      'The SnapshotStore adapter persists snapshot metadata and append-only audit history. Contracted workspace bytes live behind the Versioning adapter via gitRef, not in SnapshotStore. SQLite is the shipped default; Postgres ships as a provider package; additional relational implementations must satisfy the same lookup and audit-log contracts.',
  }),
];
