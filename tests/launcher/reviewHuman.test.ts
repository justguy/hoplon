/**
 * tests/launcher/reviewHuman.test.ts — ANSI renderer proof (t-072).
 */

import { describe, it, expect } from 'vitest';

import { renderReviewHuman } from '../../src/hoplon/launcher/reviewHuman.js';
import type { SessionReviewPayload } from '../../src/hoplon/contracts/reviewPayload.js';

function samplePayload(): SessionReviewPayload {
  return {
    version: 1,
    sessionId: 'sess-abc',
    state: 'edited',
    phase: 'post-edit',
    generatedAt: '2026-04-21T10:00:00Z',
    changedFiles: ['src/foo.ts'],
    changeKindCounts: { full_file: 0, patch: 1, structural: 0 },
    files: [
      {
        path: 'src/foo.ts',
        boundaries: [
          {
            symbol: 'alpha',
            symbolKind: 'function_declaration',
            side: 'after',
            byteRange: [10, 50],
            lineRange: [2, 5],
            changeMode: 'modified',
            unifiedDiff:
              '@@ -2,3 +2,3 @@\n-  return 1;\n+  return 7;\n ',
          },
        ],
        fallback: null,
      },
    ],
    impact: {
      dependencyImpact: {
        version: 1,
        advisory: true,
        status: 'UNAVAILABLE',
        evidence: {
          status: 'NO_VERDICT',
          reason: 'not_requested',
          detail: null,
          deterministicVerdict: null,
          representsGreenProof: false,
        },
        reason: 'not_requested',
        detail: null,
        subjects: [],
        subjectCounts: { symbol: 0, file: 0 },
        blastRadius: null,
        warnThreshold: null,
      },
      relevantTests: { status: 'UNAVAILABLE', reason: 'not_requested' },
    },
    notes: ['impact_dependencyImpact_opted_out', 'impact_relevantTests_opted_out'],
  };
}

describe('renderReviewHuman (t-072)', () => {
  it('emits ANSI codes by default for header, symbol markers, and diff prefixes', () => {
    const text = renderReviewHuman(samplePayload());
    // Some ANSI reset after our painted segments
    expect(text).toContain('[0m');
    // Bold header present
    expect(text).toContain('Hoplon review');
    // Symbol name rendered
    expect(text).toContain('alpha');
    // The `-  return 1;` line should be wrapped in red (31)
    expect(text).toContain('[31m-  return 1;');
    // The `+  return 7;` line should be wrapped in green (32)
    expect(text).toContain('[32m+  return 7;');
    // The hunk header line should be cyan (36)
    expect(text).toContain('[36m@@ -2,3 +2,3 @@');
  });

  it('omits ANSI codes when color=false so non-TTY sinks stay clean', () => {
    const text = renderReviewHuman(samplePayload(), { color: false });
    expect(text).not.toContain('[');
    expect(text).toContain('Hoplon review');
    expect(text).toContain('alpha');
    expect(text).toContain('-  return 1;');
    expect(text).toContain('+  return 7;');
  });

  it('renders honest UNAVAILABLE markers for impact panes that were not requested', () => {
    const text = renderReviewHuman(samplePayload(), { color: false });
    expect(text).toContain('dependency-impact:');
    expect(text).toContain('status=UNAVAILABLE');
    expect(text).toContain('reason=not_requested');
    expect(text).toContain('relevant-tests:');
  });

  it('renders a fallback block when boundary resolution degraded', () => {
    const payload = samplePayload();
    payload.files[0]!.boundaries = [];
    payload.files[0]!.fallback = {
      reason: 'no_code_intelligence',
      message: 'No code-intelligence adapter available.',
      unifiedDiff: '--- a/src/foo.ts\n+++ b/src/foo.ts\n@@ -1,1 +1,1 @@\n-a\n+b',
    };
    const text = renderReviewHuman(payload, { color: false });
    expect(text).toContain('fallback: no_code_intelligence');
    expect(text).toContain('-a');
    expect(text).toContain('+b');
  });

  it('renders the full relevant-tests list without truncating agent-facing review data', () => {
    const payload = samplePayload();
    payload.impact.relevantTests = {
      status: 'AVAILABLE',
      result: {
        coverageConfidence: 'exact',
        relevantTests: Array.from({ length: 12 }, (_, idx) => `tests/t${idx + 1}.test.ts`),
        unusedModifiedFiles: [],
      },
    };
    const text = renderReviewHuman(payload, { color: false });
    expect(text).toContain('tests/t1.test.ts');
    expect(text).toContain('tests/t12.test.ts');
    expect(text).not.toContain('more)');
  });
});
