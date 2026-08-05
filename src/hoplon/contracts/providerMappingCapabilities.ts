import type { ProviderMappingEntry } from './providerMapping.js';
import { PROVIDER_MAPPING_CAPABILITIES_PART_1 } from './providerMappingCapabilitiesPart1.js';
import { PROVIDER_MAPPING_CAPABILITIES_PART_2 } from './providerMappingCapabilitiesPart2.js';

export const PROVIDER_MAPPING_CAPABILITIES: ProviderMappingEntry[] = [
  ...PROVIDER_MAPPING_CAPABILITIES_PART_1,
  ...PROVIDER_MAPPING_CAPABILITIES_PART_2,
];
