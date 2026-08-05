import {
  STAGE_MAX_AGGREGATE_BYTES,
  type StagingAggregateBudget,
} from './stagingContracts.js';
import { assertPositiveSafeInteger } from './stagingInternals.js';

export function createStagingAggregateBudget(
  maxTotalBytes: number = STAGE_MAX_AGGREGATE_BYTES,
): StagingAggregateBudget {
  assertPositiveSafeInteger('maxAggregateBytes', maxTotalBytes);
  let used = 0;
  return {
    maxTotalBytes,
    usedBytes: () => used,
    tryReserve(bytes: number): boolean {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return false;
      if (used + bytes > maxTotalBytes) return false;
      used += bytes;
      return true;
    },
    release(bytes: number): void {
      if (!Number.isSafeInteger(bytes) || bytes < 0) return;
      // Clamp defensively: accounting is exact by construction, but an
      // over-release must never let the pool go negative and mint capacity.
      used = Math.max(0, used - bytes);
    },
  };
}
