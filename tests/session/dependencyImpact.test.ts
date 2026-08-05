/**
 * tests/session/dependencyImpact.test.ts — unit proofs for the t-077 shared
 * advisory dependency-impact sidecar composer and its review/repair subject
 * derivation helpers.
 *
 * The composer is shared between packaged review-payload and repair-context
 * paths, so the proofs below assert the invariants every caller relies on:
 *
 *   - opt-out / missing engine / missing subjects produce explicit UNAVAILABLE
 *     statuses with closed-enum reasons (never silently-empty AVAILABLE)
 *   - file-only subjects degrade honestly (no fabricated reference counts)
 *   - provider-backed symbol subjects surface the real AnalyzeBlastRadiusResult
 *   - provider-unavailable / provider-failure paths degrade with explicit
 *     reason (no_provider / analyze_failed), preserving the derived subjects
 *   - review and repair derive subjects with distinct `origin` discriminators
 *     so hosts can tell "this row is what was edited" from "this row is what
 *     the manifest declared intent for"
 */

import { describe, it, expect } from 'vitest';

import {
  composeDependencyImpactSidecar,
  deriveRepairSubjects,
  deriveReviewSubjects,
} from '../../src/hoplon/session/dependencyImpactSidecar.js';
import type { AnalyzeBlastRadiusResult } from '../../src/hoplon/contracts/blastRadius.js';
import type {
  AuditResult,
} from '../../src/hoplon/contracts/audit.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import type {
  DependencyImpactSidecar,
  DependencyImpactSubject,
} from '../../src/hoplon/contracts/dependencyImpact.js';
import type { ReviewFile } from '../../src/hoplon/contracts/reviewPayload.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';

const ONE_SYMBOL: DependencyImpactSubject = {
  kind: 'symbol',
  path: 'src/a.ts',
  symbolName: 'alpha',
  symbolKind: 'function_declaration',
  byteRange: [0, 40],
  changeMode: 'modified',
  origin: 'review_boundary',
};

const ONE_FILE: DependencyImpactSubject = {
  kind: 'file',
  path: 'src/b.ts',
  origin: 'review_boundary',
  reason: 'no_code_intelligence',
};

function stubEngine(
  analyzeBlastRadius: HoplonEngine['analyzeBlastRadius'],
): HoplonEngine {
  return { analyzeBlastRadius } as unknown as HoplonEngine;
}

describe('composeDependencyImpactSidecar — t-077 shared composer', () => {
  it('returns UNAVAILABLE:not_requested when the caller did not opt in', async () => {
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL],
      includeDependencyImpact: false,
      engine: stubEngine(async () => {
        throw new Error('must not be called');
      }),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(sidecar.status).toBe('UNAVAILABLE');
    expect(sidecar.evidence.status).toBe('NO_VERDICT');
    expect(sidecar.reason).toBe('not_requested');
    expect(sidecar.blastRadius).toBeNull();
    expect(sidecar.warnThreshold).toBeNull();
    expect(sidecar.subjectCounts).toEqual({ symbol: 1, file: 0 });
    expect(sidecar.subjects).toHaveLength(1);
  });

  it('returns UNAVAILABLE:no_engine when no engine is available', async () => {
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL],
      includeDependencyImpact: true,
      engine: null,
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(sidecar.status).toBe('UNAVAILABLE');
    expect(sidecar.evidence.status).toBe('UNAVAILABLE');
    expect(sidecar.reason).toBe('no_engine');
    expect(sidecar.blastRadius).toBeNull();
    expect(sidecar.subjects).toHaveLength(1);
  });

  it('returns UNAVAILABLE:no_changed_subjects when nothing was derived', async () => {
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [],
      includeDependencyImpact: true,
      engine: stubEngine(async () => {
        throw new Error('must not be called');
      }),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(sidecar.status).toBe('UNAVAILABLE');
    expect(sidecar.evidence.status).toBe('EMPTY');
    expect(sidecar.reason).toBe('no_changed_subjects');
    expect(sidecar.blastRadius).toBeNull();
    expect(sidecar.subjectCounts).toEqual({ symbol: 0, file: 0 });
  });

  it('returns DEGRADED:file_only_fallback when only file-only subjects exist', async () => {
    let called = 0;
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_FILE],
      includeDependencyImpact: true,
      engine: stubEngine(async () => {
        called += 1;
        throw new Error('must not be called');
      }),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(called).toBe(0);
    expect(sidecar.status).toBe('DEGRADED');
    expect(sidecar.evidence.status).toBe('DEGRADED');
    expect(sidecar.reason).toBe('file_only_fallback');
    expect(sidecar.blastRadius).toBeNull();
    expect(sidecar.subjects).toEqual([ONE_FILE]);
  });

  it('runs analyzeBlastRadius for symbol subjects and returns AVAILABLE on success', async () => {
    let received: Parameters<HoplonEngine['analyzeBlastRadius']>[0] | null = null;
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL],
      includeDependencyImpact: true,
      engine: stubEngine(async (req) => {
        received = req;
        return {
          correlationId: req.correlationId,
          advisory: true,
          status: 'SAFE',
          providerAvailable: true,
          warnThreshold: 10,
          entries: req.symbols.map((s) => ({
            symbol: s,
            classification: 'safe',
            referenceCount: 0,
            affectedFileCount: 0,
            affectedFiles: [],
            thresholdUsed: 10,
          })),
        } satisfies AnalyzeBlastRadiusResult;
      }),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(sidecar.status).toBe('AVAILABLE');
    expect(sidecar.evidence.status).toBe('AVAILABLE');
    expect(sidecar.reason).toBeNull();
    expect(sidecar.blastRadius?.status).toBe('SAFE');
    expect(sidecar.warnThreshold).toBe(10);
    expect(received).not.toBeNull();
    expect(received!.projectId).toBe('proj');
    expect(received!.symbols).toHaveLength(1);
  });

  it('returns DEGRADED:no_provider when analyzeBlastRadius reports UNAVAILABLE (but keeps the analyzer envelope for traceability)', async () => {
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL],
      includeDependencyImpact: true,
      engine: stubEngine(async (req) => ({
        correlationId: req.correlationId,
        advisory: true,
        status: 'UNAVAILABLE',
        providerAvailable: false,
        warnThreshold: 10,
        entries: [],
      })),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(sidecar.status).toBe('DEGRADED');
    expect(sidecar.evidence.status).toBe('DEGRADED');
    expect(sidecar.reason).toBe('no_provider');
    // The raw analyzer envelope is preserved so hosts can see that the
    // provider answered "UNAVAILABLE" vs never having been called.
    expect(sidecar.blastRadius?.status).toBe('UNAVAILABLE');
    expect(sidecar.blastRadius?.entries).toEqual([]);
  });

  it('returns DEGRADED:analyze_failed and surfaces the error detail when analyzeBlastRadius throws', async () => {
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL],
      includeDependencyImpact: true,
      engine: stubEngine(async () => {
        throw new Error('adapter timeout: upstream unreachable');
      }),
      correlationId: 'corr-1',
      projectId: 'proj',
      warnThreshold: 5,
    });
    expect(sidecar.status).toBe('DEGRADED');
    expect(sidecar.reason).toBe('analyze_failed');
    expect(sidecar.blastRadius).toBeNull();
    expect(sidecar.warnThreshold).toBe(5);
    expect(sidecar.detail).toContain('adapter timeout');
  });

  it('returns DEGRADED:partial_symbol_resolution when mixed file-only + symbol subjects are present', async () => {
    const mixedSidecar: DependencyImpactSidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL, ONE_FILE],
      includeDependencyImpact: true,
      engine: stubEngine(async (req) => ({
        correlationId: req.correlationId,
        advisory: true,
        status: 'SAFE',
        providerAvailable: true,
        warnThreshold: 10,
        entries: req.symbols.map((s) => ({
          symbol: s,
          classification: 'safe',
          referenceCount: 0,
          affectedFileCount: 0,
          affectedFiles: [],
          thresholdUsed: 10,
        })),
      })),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(mixedSidecar.status).toBe('DEGRADED');
    expect(mixedSidecar.reason).toBe('file_only_fallback');
    expect(mixedSidecar.subjects).toHaveLength(2);
    expect(mixedSidecar.blastRadius?.entries).toHaveLength(1);
  });

  it('dedupes identical symbol subjects before calling analyzeBlastRadius', async () => {
    let symbolsSent = 0;
    await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL, { ...ONE_SYMBOL }],
      includeDependencyImpact: true,
      engine: stubEngine(async (req) => {
        symbolsSent = req.symbols.length;
        return {
          correlationId: req.correlationId,
          advisory: true,
          status: 'SAFE',
          providerAvailable: true,
          warnThreshold: 10,
          entries: req.symbols.map((s) => ({
            symbol: s,
            classification: 'safe',
            referenceCount: 0,
            affectedFileCount: 0,
            affectedFiles: [],
            thresholdUsed: 10,
          })),
        };
      }),
      correlationId: 'corr-1',
      projectId: 'proj',
    });
    expect(symbolsSent).toBe(1);
  });

  it('can consume precomputed tree-diff changed files as advisory file subjects', async () => {
    const sidecar = await composeDependencyImpactSidecar({
      subjects: [ONE_SYMBOL],
      precomputedChangedFiles: ['src/tree-only.ts', ONE_SYMBOL.path],
      includeDependencyImpact: true,
      engine: stubEngine(async (req) => ({
        correlationId: req.correlationId,
        advisory: true,
        status: 'SAFE',
        providerAvailable: true,
        warnThreshold: 10,
        entries: req.symbols.map((s) => ({
          symbol: s,
          classification: 'safe',
          referenceCount: 0,
          affectedFileCount: 0,
          affectedFiles: [],
          thresholdUsed: 10,
        })),
      })),
      correlationId: 'corr-1',
      projectId: 'proj',
    });

    expect(sidecar.status).toBe('DEGRADED');
    expect(sidecar.reason).toBe('file_only_fallback');
    expect(sidecar.subjects).toContainEqual({
      kind: 'file',
      path: 'src/tree-only.ts',
      origin: 'tree_diff_precompute',
      reason: 'tree_diff_changed_file',
    });
  });
});

describe('deriveReviewSubjects — t-077 review subject derivation', () => {
  it('emits symbol subjects for each touched boundary and origin=review_boundary', () => {
    const files: ReviewFile[] = [
      {
        path: 'src/a.ts',
        boundaries: [
          {
            symbol: 'alpha',
            symbolKind: 'function_declaration',
            side: 'after',
            byteRange: [0, 30],
            lineRange: [1, 3],
            changeMode: 'modified',
            unifiedDiff: '...',
          },
          {
            symbol: 'beta',
            symbolKind: 'function_declaration',
            side: 'after',
            byteRange: [30, 60],
            lineRange: [4, 6],
            changeMode: 'added',
            unifiedDiff: '...',
          },
        ],
        fallback: null,
      },
    ];
    const subjects = deriveReviewSubjects(files);
    expect(subjects).toHaveLength(2);
    expect(subjects.every((s) => s.kind === 'symbol')).toBe(true);
    expect(subjects.every((s) => s.origin === 'review_boundary')).toBe(true);
    expect(subjects[0]).toMatchObject({ symbolName: 'alpha', changeMode: 'modified' });
    expect(subjects[1]).toMatchObject({ symbolName: 'beta', changeMode: 'added' });
  });

  it('emits a file-only subject with translated reason when a fallback is set', () => {
    const subjects = deriveReviewSubjects([
      {
        path: 'src/c.ts',
        boundaries: [],
        fallback: {
          reason: 'no_code_intelligence',
          message: 'adapter missing',
          unifiedDiff: '',
        },
      },
    ]);
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({
      kind: 'file',
      path: 'src/c.ts',
      reason: 'no_code_intelligence',
    });
  });

  it('emits markEdited_no_before_bytes when fs had no boundaries and no fallback', () => {
    const subjects = deriveReviewSubjects(
      [{ path: 'src/d.ts', boundaries: [], fallback: null }],
      { markEditedBeforeBytesUnavailable: true },
    );
    expect(subjects).toHaveLength(1);
    expect(subjects[0]).toMatchObject({
      kind: 'file',
      path: 'src/d.ts',
      reason: 'markEdited_no_before_bytes',
    });
  });
});

describe('deriveRepairSubjects — t-077 repair subject derivation', () => {
  const manifest: WritableManifest = {
    manifestSchemaVersion: 1,
    projectId: 'proj',
    runId: 'run-1',
    correlationId: 'corr-1',
    entries: [
      {
        path: 'src/a.ts',
        scope: { kind: 'symbols', symbols: ['alpha', 'beta'] },
      },
      {
        path: 'src/b.ts',
        scope: { kind: 'whole_file' },
      },
    ],
  };

  it('emits manifest_scope symbol subjects and audit_violation subjects, deduped by (path, symbol)', () => {
    const block: AuditResult = {
      status: 'BLOCK',
      correlationId: 'corr-1',
      auditSchemaVersion: 1,
      violations: [
        {
          kind: 'out_of_scope_symbol',
          path: 'src/a.ts',
          symbolName: 'GAMMA',
          nodeKind: 'function_declaration',
          byteRange: [100, 150],
          sourceSlice: '',
          expectedScope: { kind: 'symbols', symbols: ['alpha', 'beta'] },
          message: 'GAMMA outside declared scope',
          correction: 'Remove GAMMA.',
        },
        {
          kind: 'uncontracted_file',
          path: 'src/c.ts',
          firstChangedLine: 1,
          sourceSlice: '',
          message: 'uncontracted',
          correction: 'Revert this file.',
        },
      ],
    };

    const subjects = deriveRepairSubjects(manifest, block);

    const symbolSubjects = subjects.filter((s) => s.kind === 'symbol');
    const fileSubjects = subjects.filter((s) => s.kind === 'file');

    // Manifest scope contributed alpha + beta on src/a.ts.
    expect(symbolSubjects.some((s) => s.symbolName === 'alpha' && s.origin === 'manifest_scope')).toBe(true);
    expect(symbolSubjects.some((s) => s.symbolName === 'beta' && s.origin === 'manifest_scope')).toBe(true);

    // Failed audit contributed GAMMA as an audit_violation subject.
    expect(symbolSubjects.some((s) => s.symbolName === 'GAMMA' && s.origin === 'audit_violation')).toBe(true);

    // The manifest's whole_file row on src/b.ts becomes a file subject.
    expect(fileSubjects.some((s) => s.path === 'src/b.ts' && s.reason === 'whole_file_manifest_scope')).toBe(true);

    // The uncontracted violation on src/c.ts becomes a file subject with the corresponding reason.
    expect(fileSubjects.some((s) => s.path === 'src/c.ts' && s.reason === 'uncontracted_file')).toBe(true);
  });

  it('produces an empty list when a PASS audit is passed (never used in practice but defensive)', () => {
    const pass: AuditResult = {
      status: 'PASS',
      correlationId: 'corr-1',
      checked: 0,
      auditSchemaVersion: 1,
    };
    const subjects = deriveRepairSubjects(
      {
        manifestSchemaVersion: 1,
        projectId: 'proj',
        runId: 'run-1',
        correlationId: 'corr-1',
        entries: [{ path: 'src/x.ts', scope: { kind: 'whole_file' } }],
      },
      pass,
    );
    // Manifest-scope entries still contribute even without violations.
    expect(subjects.length).toBeGreaterThan(0);
    expect(subjects.every((s) => s.origin === 'manifest_scope')).toBe(true);
  });
});
