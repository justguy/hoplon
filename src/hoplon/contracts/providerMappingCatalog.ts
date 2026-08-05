/**
 * providerMappingCatalog.ts — aggregated ecosystem → seam mapping (t-047).
 *
 * Re-exports the concatenation of capability-backed and core-adapter ecosystem
 * entries. Every capability in `CapabilityIdSchema` has at least one entry
 * pointing at it; every named core-adapter ecosystem (emitter, lockProvider,
 * snapshotStore) is recorded separately so the design truth does not fold
 * into the capability catalog.
 *
 * Consistency against `buildCapabilityCatalog()` is enforced by
 * `tests/contracts/providerMapping.test.ts`.
 */

import type { ProviderMappingList } from './providerMapping.js';
import { PROVIDER_MAPPING_CAPABILITIES } from './providerMappingCapabilities.js';
import { PROVIDER_MAPPING_CORE_ADAPTERS } from './providerMappingCoreAdapters.js';

export const PROVIDER_MAPPING: ProviderMappingList = [
  ...PROVIDER_MAPPING_CAPABILITIES,
  ...PROVIDER_MAPPING_CORE_ADAPTERS,
];
