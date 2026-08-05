import type { CapabilityContractReport } from '../contracts/capabilities.js';
import {
  descriptor,
  withoutHealth,
} from './describeCapabilitiesCatalogHelpers.js';

export function buildContractOnlyCapabilityReports(): CapabilityContractReport[] {
  return [
    withoutHealth(
      descriptor({
        capabilityId: 'versionSyncedIntelligence',
        name: 'Version-Synced Intelligence Metadata',
        integrationPoint: 'host_composition',
        runtimeState: 'contract_only',
        defaultBinding: 'none',
        sideEffectPosture: 'none',
        failureIsolation: 'host_invoked_only',
        invocationMode: 'host_invoked',
        versionMetadata: [
          'capability_contract_v1',
          'provider_version',
          'workspace_revision',
          'manifest_schema_version',
          'snapshot_ref',
        ],
        dataAccess: [
          { dataClass: 'workspace_content', access: 'read_only' },
          { dataClass: 'snapshot_metadata', access: 'read_only' },
          { dataClass: 'provider_metadata', access: 'read_only' },
        ],
        notes:
          'This preserves revision-aware metadata without hardcoding one provider or storage engine into core. SCIP snapshots and similar offline indices belong here when a host needs explicit workspace-revision or freshness reporting.',
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'semanticGapAnalysis',
        name: 'Semantic Gap Analysis',
        integrationPoint: 'plugin_contract',
        runtimeState: 'contract_only',
        defaultBinding: 'none',
        sideEffectPosture: 'none',
        failureIsolation: 'host_invoked_only',
        invocationMode: 'explicit_extension_call',
        versionMetadata: ['capability_contract_v1', 'provider_version', 'workspace_revision'],
        dataAccess: [
          { dataClass: 'workspace_content', access: 'read_only' },
          { dataClass: 'audit_evidence', access: 'read_only' },
          { dataClass: 'host_objective', access: 'read_only' },
        ],
        notes:
          'This remains contract-only until input/output is intentionally wired against manifest, audit evidence, and host objective.',
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'semanticTwins',
        name: 'Semantic Twins / Fix Propagation',
        integrationPoint: 'plugin_contract',
        runtimeState: 'contract_only',
        defaultBinding: 'none',
        sideEffectPosture: 'none',
        failureIsolation: 'host_invoked_only',
        invocationMode: 'explicit_extension_call',
        versionMetadata: [
          'capability_contract_v1',
          'provider_version',
          'workspace_revision',
          'snapshot_ref',
        ],
        dataAccess: [
          { dataClass: 'snapshot_metadata', access: 'read_only' },
          { dataClass: 'audit_evidence', access: 'read_only' },
        ],
        notes:
          'The rewrite boundary preserves this as an explicit extension capability over snapshots, manifests, and audit outputs.',
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'mutationTesting',
        name: 'Mutation Testing',
        integrationPoint: 'plugin_contract',
        runtimeState: 'contract_only',
        defaultBinding: 'none',
        sideEffectPosture: 'none',
        failureIsolation: 'host_invoked_only',
        invocationMode: 'explicit_extension_call',
        versionMetadata: [
          'capability_contract_v1',
          'provider_version',
          'workspace_revision',
          'snapshot_ref',
        ],
        dataAccess: [
          { dataClass: 'snapshot_metadata', access: 'read_only' },
          { dataClass: 'audit_evidence', access: 'read_only' },
        ],
        notes:
          'Mutation execution remains host-owned and isolated from the deterministic workspace contract. Hoplon preserves the DTO seam only.',
      }),
    ),
    withoutHealth(
      descriptor({
        capabilityId: 'complianceExports',
        name: 'Compliance Exports / Reporting',
        integrationPoint: 'host_export',
        runtimeState: 'contract_only',
        defaultBinding: 'none',
        sideEffectPosture: 'export_only',
        failureIsolation: 'host_invoked_only',
        invocationMode: 'host_invoked',
        versionMetadata: [
          'capability_contract_v1',
          'provider_version',
          'workspace_revision',
          'snapshot_ref',
        ],
        dataAccess: [
          { dataClass: 'snapshot_metadata', access: 'read_only' },
          { dataClass: 'audit_evidence', access: 'read_only' },
        ],
        notes:
          'Evidence export remains outside the deterministic gate path. The seam stays explicit so host export/report layers can adopt it later.',
      }),
    ),
  ];
}
