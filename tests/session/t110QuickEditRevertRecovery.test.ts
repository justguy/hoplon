import { describe, expect, it } from 'vitest';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import { NON_IDEMPOTENT_REVERT_GUIDANCE } from '../../src/hoplon/operations/revertRecoveryGuards.js';
import { quickEdit } from '../../src/hoplon/session/quickEdit.js';
import { BLOCK_AUDIT, MANIFEST, makeMockEngine } from './helpers.js';

describe('t-110 quickEdit revert recovery visibility', () => {
  it('preserves non-idempotent revert guidance on the failed revert phase', async () => {
    const revertError = new AdapterError(
      {
        kind: 'fs_write_failed',
        engineId: 'test-engine',
        correlationId: MANIFEST.correlationId,
      },
      `synthetic revert failure. ${NON_IDEMPOTENT_REVERT_GUIDANCE}`,
    );
    const result = await quickEdit({
      engine: makeMockEngine({
        auditDiff: async () => BLOCK_AUDIT,
        revertUncontracted: async () => {
          throw revertError;
        },
      }),
      manifest: MANIFEST,
      fs: createMemFsAdapter(),
      proposedChanges: [
        { file: 'src/foo.ts', content: 'export const bad = 1;\n' },
      ],
    });

    expect(result.outcome).toBe('failed');
    if (result.outcome !== 'failed') throw new Error('unreachable');
    expect(result.phase).toBe('revert');
    expect(result.error).toBe(revertError);
    expect(result.error.message).toMatch(/not idempotent/);
    expect(result.error.message).toMatch(/do not retry blindly/);
    expect(result.auditResult?.status).toBe('BLOCK');
    expect(result.revertResult).toBeNull();
    expect(result.finalState).toBe('closed');
  });
});
