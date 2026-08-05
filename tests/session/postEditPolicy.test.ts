import { describe, expect, it } from 'vitest';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type {
  PostEditPolicyFinding,
  PostEditPolicyScanner,
} from '../../src/hoplon/contracts/postEditPolicy.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

const RAW_SECRET = 'sk_live_1234567890abcdef';

function scannerFromFinding(
  finding: PostEditPolicyFinding,
): PostEditPolicyScanner {
  return {
    providerId: 'test-policy',
    async scan(input) {
      if (input.afterBytes === null) return [];
      const text = new TextDecoder().decode(input.afterBytes);
      return text.includes(RAW_SECRET) ? [finding] : [];
    },
  };
}

describe('session post-edit policy sidecar — t-115', () => {
  it('surfaces redacted findings for preview bytes without advancing session state', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const token = "";\n'));
    const scanner = scannerFromFinding({
      ruleId: 'secret-token',
      category: 'secret',
      path: 'src/foo.ts',
      lineNumber: 1,
      redactedSnippet: 'export const token = "[REDACTED]";',
      detail: null,
    });
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      postEditPolicyScanner: scanner,
    });
    await session.preflight();
    await session.createSnapshot();

    const payload = await session.getReviewPayload({
      phase: 'preview',
      includePostEditPolicyScan: true,
      proposedChanges: [
        { file: 'src/foo.ts', content: `export const token = "${RAW_SECRET}";\n` },
      ],
    });

    expect(session.state).toBe('snapshotted');
    expect(payload.impact.postEditPolicy.advisory).toBe(true);
    expect(payload.impact.postEditPolicy.status).toBe('AVAILABLE');
    expect(payload.impact.postEditPolicy.findings).toHaveLength(1);
    expect(payload.impact.postEditPolicy.findings[0]!.redactedSnippet).toContain(
      '[REDACTED]',
    );
    expect(payload.impact.postEditPolicy.findings[0]!.redactedSnippet).not.toContain(
      RAW_SECRET,
    );
    expect(payload.impact.postEditPolicy.authority.canChangeDeterministicVerdict).toBe(
      false,
    );
  });

  it('surfaces redacted findings for applied bytes without changing audit outcome', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const token = "";\n'));
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      postEditPolicyScanner: scannerFromFinding({
        ruleId: 'secret-token',
        category: 'secret',
        path: 'src/foo.ts',
        lineNumber: 1,
        redactedSnippet: 'export const token = "[REDACTED]";',
        detail: null,
      }),
    });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([
      { file: 'src/foo.ts', content: `export const token = "${RAW_SECRET}";\n` },
    ]);

    const payload = await session.getReviewPayload({
      includePostEditPolicyScan: true,
    });
    expect(payload.impact.postEditPolicy.status).toBe('AVAILABLE');
    const audit = await session.audit();
    expect(audit.status).toBe('PASS');
    expect(session.state).toBe('audited_pass');
    expect(JSON.stringify(session.snapshot.history)).not.toContain(RAW_SECRET);
  });

  it('reports explicit unavailable/empty/degraded states without throwing', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const ok = true;\n'));
    const noScannerSession = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
    });
    await noScannerSession.preflight();
    await noScannerSession.createSnapshot();
    await noScannerSession.applyEdits([
      { file: 'src/foo.ts', content: 'export const ok = false;\n' },
    ]);
    const noScanner = await noScannerSession.getReviewPayload({
      includePostEditPolicyScan: true,
    });
    expect(noScanner.impact.postEditPolicy.status).toBe('UNAVAILABLE');
    expect(noScanner.impact.postEditPolicy.reason).toBe('no_scanner');

    const emptySession = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      postEditPolicyScanner: { providerId: 'empty', async scan() { return []; } },
    });
    await emptySession.preflight();
    await emptySession.createSnapshot();
    await emptySession.applyEdits([
      { file: 'src/foo.ts', content: 'export const ok = 1;\n' },
    ]);
    const empty = await emptySession.getReviewPayload({
      includePostEditPolicyScan: true,
    });
    expect(empty.impact.postEditPolicy.status).toBe('EMPTY');
    expect(empty.impact.postEditPolicy.reason).toBe('no_findings');

    const failingSession = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      postEditPolicyScanner: {
        providerId: 'failing',
        async scan() {
          throw new Error('provider offline');
        },
      },
    });
    await failingSession.preflight();
    await failingSession.createSnapshot();
    await failingSession.applyEdits([
      { file: 'src/foo.ts', content: 'export const ok = 2;\n' },
    ]);
    const degraded = await failingSession.getReviewPayload({
      includePostEditPolicyScan: true,
    });
    expect(degraded.impact.postEditPolicy.status).toBe('DEGRADED');
    expect(degraded.impact.postEditPolicy.reason).toBe('scanner_failed');
    expect(degraded.impact.postEditPolicy.findings).toEqual([]);
  });
});
