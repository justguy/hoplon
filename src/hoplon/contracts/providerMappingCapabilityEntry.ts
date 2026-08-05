/**
 * providerMappingCapabilities.ts — capability-backed ecosystem entries (t-047).
 *
 * One entry per capability in `CapabilityIdSchema`. Kept separate from core
 * adapter ecosystem entries so both files stay under the repo line-cap and the
 * consistency test can check capability-backed entries directly against the
 * descriptors produced by `buildCapabilityCatalog()`.
 */

import type {
  CapabilityDataAccessEntry,
  CapabilityFailureIsolation,
  CapabilityId,
  CapabilityInvocationMode,
  CapabilityRuntimeState,
  CapabilitySideEffectPosture,
} from './capabilities.js';
import type { ProviderMappingEntry } from './providerMapping.js';

export type CapabilityEntryInit = {
  ecosystem: string;
  ecosystemName: string;
  candidateTools: string[];
  capabilityId: CapabilityId;
  runtimeState: CapabilityRuntimeState;
  invocationMode: CapabilityInvocationMode;
  sideEffectPosture: CapabilitySideEffectPosture;
  failureIsolation: CapabilityFailureIsolation;
  dataAccess: CapabilityDataAccessEntry[];
  notes: string;
};

export function capabilityEntry(init: CapabilityEntryInit): ProviderMappingEntry {
  return { mappingSchemaVersion: 1, seamKind: 'capability', ...init };
}
