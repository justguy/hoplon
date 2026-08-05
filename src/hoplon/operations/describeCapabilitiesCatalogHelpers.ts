/**
 * describeCapabilitiesCatalogHelpers.ts — shared builder helpers for the
 * capability catalog inventory.
 */

import type {
  CapabilityContractReport,
  CapabilityDescriptor,
} from '../contracts/capabilities.js';
import type { AdapterStatus } from '../contracts/health.js';

const SHARED_CORRELATION = [
  'engineId',
  'correlationId',
  'projectId',
  'runId',
  'snapshotRefId',
] as const;

type DescriptorInit = Omit<
  CapabilityDescriptor,
  'contractSchemaVersion' | 'correlationFields' | 'defaultWritePosture'
> &
  Partial<
    Pick<
      CapabilityDescriptor,
      'correlationFields' | 'defaultWritePosture'
    >
  >;

export function descriptor(init: DescriptorInit): CapabilityDescriptor {
  return {
    contractSchemaVersion: 1,
    defaultWritePosture: 'read_only',
    correlationFields: [...SHARED_CORRELATION],
    ...init,
  };
}

export function withHealth(
  descriptor: CapabilityDescriptor,
  adapterStatus: AdapterStatus,
): CapabilityContractReport {
  return {
    descriptor,
    healthStatus: mapHealth(adapterStatus),
  };
}

export function withoutHealth(
  descriptor: CapabilityDescriptor,
): CapabilityContractReport {
  return { descriptor };
}

function mapHealth(
  status: AdapterStatus,
): CapabilityContractReport['healthStatus'] {
  if (status === 'ok') return 'available';
  if (status === 'degraded') return 'degraded';
  return 'unavailable';
}
