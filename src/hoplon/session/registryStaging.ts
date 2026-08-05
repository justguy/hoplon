import {
  createStagingAggregateBudget,
  STAGE_MAX_AGGREGATE_BYTES,
  type SessionStagingOptions,
} from './stagingStore.js';

export function createRegistryStagingOptions(
  options: SessionStagingOptions | undefined,
): SessionStagingOptions {
  if (options?.aggregateBudget !== undefined) {
    return options;
  }
  const maxAggregateBytes =
    options?.maxAggregateBytes ?? STAGE_MAX_AGGREGATE_BYTES;
  return {
    ...options,
    aggregateBudget: createStagingAggregateBudget(maxAggregateBytes),
  };
}
