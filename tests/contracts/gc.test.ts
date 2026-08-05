import { describe, expect, it } from 'vitest';

import { GcRequestSchema, GcResultSchema } from '../../src/hoplon/contracts/gc.js';

describe('gc contract', () => {
  it('accepts snapshot and semantic maintenance flags', () => {
    const parsed = GcRequestSchema.safeParse({
      projectId: 'project-a',
      semanticCache: true,
      semanticOverlays: true,
      semanticTombstones: true,
    });
    expect(parsed.success).toBe(true);
  });

  it('returns semantic maintenance counts without content-bearing fields', () => {
    const parsed = GcResultSchema.parse({
      deletedCount: 0,
      semanticCacheEntriesDeleted: 0,
      semanticOverlaysReaped: 2,
      semanticTombstonesDeleted: 0,
      degradationReasons: [
        'semantic_cache_maintenance_provider_not_bound',
        'semantic_tombstone_maintenance_provider_not_bound',
      ],
    });

    expect(parsed).toEqual({
      deletedCount: 0,
      semanticCacheEntriesDeleted: 0,
      semanticOverlaysReaped: 2,
      semanticTombstonesDeleted: 0,
      degradationReasons: [
        'semantic_cache_maintenance_provider_not_bound',
        'semantic_tombstone_maintenance_provider_not_bound',
      ],
    });
    expect(Object.keys(parsed).sort()).toEqual([
      'degradationReasons',
      'deletedCount',
      'semanticCacheEntriesDeleted',
      'semanticOverlaysReaped',
      'semanticTombstonesDeleted',
    ]);
  });
});
