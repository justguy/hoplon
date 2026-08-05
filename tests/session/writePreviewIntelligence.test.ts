/**
 * tests/session/writePreviewIntelligence.test.ts - t-103 advisory write-
 * preview sidecar proof.
 */

import { describe, expect, it } from 'vitest';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type {
  CodeIntelligenceAdapter,
  Symbol as CiSymbol,
  SyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence.js';
import { SessionReviewPayloadSchema } from '../../src/hoplon/contracts/reviewPayload.js';
import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

function fakeCodeIntelligence(
  bySource: (text: string) => CiSymbol[],
): CodeIntelligenceAdapter {
  return {
    async parse(_file, bytes) {
      return {
        rootNode: { kind: 'program', children: [new TextDecoder().decode(bytes)] },
      } as unknown as SyntaxTree;
    },
    getTopLevelSymbols(tree) {
      const text = (tree as unknown as { rootNode: { children: unknown[] } })
        .rootNode.children[0] as string;
      return bySource(text);
    },
  };
}

function rangeOfBlock(source: string, start: string, end: string): [number, number] {
  const idx = source.indexOf(start);
  if (idx < 0) throw new Error(`block start "${start}" not found`);
  const close = source.indexOf(end, idx);
  if (close < 0) throw new Error(`block end "${end}" not found`);
  return [
    Buffer.byteLength(source.slice(0, idx), 'utf8'),
    Buffer.byteLength(source.slice(0, close + end.length), 'utf8'),
  ];
}

describe('session.getReviewPayload - t-103 write-preview intelligence', () => {
  it('keeps preview PASS while advisory blast-radius WARNING and high risk are sidecars only', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() {\n  return 1;\n}\n';
    const after = 'export function alpha() {\n  return 2;\n}\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(before));
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const engine = makeMockEngine({
      analyzeBlastRadius: async (req) => ({
        correlationId: req.correlationId,
        advisory: true,
        status: 'WARNING',
        providerAvailable: true,
        warnThreshold: 10,
        entries: req.symbols.map((symbol) => ({
          symbol,
          classification: 'warning',
          referenceCount: 17,
          affectedFileCount: 2,
          affectedFiles: ['src/downstream-a.ts', 'src/downstream-b.ts'],
          thresholdUsed: 10,
        })),
      }),
      predictViolationRisk: async () => ({
        probability: 0.99,
        riskBand: 'high',
        advisory: true,
        sampleSize: 8,
        perKindProbabilities: { uncontracted_file: 0.9 },
        featuresUsed: { projectId: MANIFEST.projectId },
        reason: 'test fixture high-risk advisory',
      }),
    });
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs, codeIntelligence: ci });
    await session.preflight();
    await session.createSnapshot();

    const proposedChanges = [{ file: 'src/foo.ts', content: after }];
    const dryRun = await session.dryRun(proposedChanges);
    const payload = await session.getReviewPayload({
      phase: 'preview',
      proposedChanges,
      includeDependencyImpact: true,
      includeViolationRisk: true,
    });

    expect(dryRun.status).toBe('PASS');
    expect(session.state).toBe('snapshotted');
    expect(SessionReviewPayloadSchema.safeParse(payload).success).toBe(true);
    const intelligence = payload.impact.advisoryIntelligence;
    expect(intelligence.blastRadius.provider.status).toBe('available');
    expect(intelligence.blastRadius.evidence.status).toBe('AVAILABLE');
    expect(intelligence.blastRadius.authority.canChangeDeterministicVerdict).toBe(false);
    expect(intelligence.blastRadius.payload.blastRadius?.status).toBe('WARNING');
    expect(intelligence.blastRadius.payload.blastRadius?.entries[0]?.affectedFileCount).toBe(2);
    expect(intelligence.violationRisk.provider.status).toBe('available');
    expect(intelligence.violationRisk.evidence.status).toBe('AVAILABLE');
    expect(intelligence.violationRisk.payload.prediction?.riskBand).toBe('high');
    expect(intelligence.violationRisk.authority.canChangeDeterministicVerdict).toBe(false);
  });

  it('returns a post-edit payload when advisory providers fail', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() {\n  return 1;\n}\n';
    const after = 'export function alpha() {\n  return 3;\n}\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(before));
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const engine = makeMockEngine({
      analyzeBlastRadius: async () => {
        throw new Error('blast provider unavailable');
      },
      predictViolationRisk: async () => {
        throw new Error('risk provider unavailable');
      },
    });
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs, codeIntelligence: ci });
    await session.preflight();
    await session.createSnapshot();
    await session.applyEdits([{ file: 'src/foo.ts', content: after }]);

    const payload = await session.getReviewPayload({
      includeDependencyImpact: true,
      includeViolationRisk: true,
    });

    expect(payload.phase).toBe('post-edit');
    expect(payload.state).toBe('edited');
    expect(SessionReviewPayloadSchema.safeParse(payload).success).toBe(true);
    expect(payload.impact.advisoryIntelligence.blastRadius.provider).toMatchObject({
      status: 'degraded',
      reason: 'analyze_failed',
    });
    expect(payload.impact.advisoryIntelligence.blastRadius.evidence.status).toBe(
      'DEGRADED',
    );
    expect(payload.impact.advisoryIntelligence.violationRisk.provider).toMatchObject({
      status: 'degraded',
      reason: 'predict_failed',
    });
    expect(payload.impact.advisoryIntelligence.violationRisk.evidence.status).toBe(
      'DEGRADED',
    );
    expect(payload.impact.advisoryIntelligence.violationRisk.payload.prediction).toBeNull();
  });

  it('keeps noop/empty violation-risk evidence distinct from available proof', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() {\n  return 1;\n}\n';
    const after = 'export function alpha() {\n  return 4;\n}\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(before));
    const ci = fakeCodeIntelligence((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const engine = makeMockEngine({
      predictViolationRisk: async () => ({
        probability: 0,
        riskBand: 'low',
        advisory: true,
        sampleSize: 0,
        perKindProbabilities: {},
        featuresUsed: { projectId: MANIFEST.projectId },
        reason: 'noop fixture with no history',
      }),
    });
    const session = createHoplonEditSession({ engine, manifest: MANIFEST, fs, codeIntelligence: ci });
    await session.preflight();
    await session.createSnapshot();

    const payload = await session.getReviewPayload({
      phase: 'preview',
      proposedChanges: [{ file: 'src/foo.ts', content: after }],
      includeDependencyImpact: false,
      includeViolationRisk: true,
    });

    const risk = payload.impact.advisoryIntelligence.violationRisk;
    expect(risk.provider.status).toBe('available');
    expect(risk.evidence.status).toBe('EMPTY');
    expect(risk.evidence.representsGreenProof).toBe(false);
    expect(risk.evidence.deterministicVerdict).toBeNull();
  });
});
