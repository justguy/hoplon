/**
 * adapters/staticAnalysis/noop.ts — No-op StaticAnalysisAdapter.
 *
 * Always returns PASS with empty findings. This is the Phase 1 default when
 * staticAnalysis is omitted from HoplonAdapters.
 *
 * Phase 4 swap target: Semgrep (LGPL) via @phalanx/hoplon-static-analysis-semgrep.
 * License note: Semgrep is LGPL — ships as a separate plugin package, never bundled.
 */

import type { StaticAnalysisAdapter } from '../staticAnalysis.js';

/**
 * Create a no-op StaticAnalysisAdapter that always returns PASS with empty findings.
 *
 * Used as the default when the optional staticAnalysis adapter is not provided
 * to createHoplonEngine(). Zero cost: no validation, no I/O.
 */
export function createNoopAnalyzer(): StaticAnalysisAdapter {
  return {
    async analyze(_req: { files: string[] }): Promise<{ status: 'PASS' | 'BLOCK'; findings: [] }> {
      return { status: 'PASS', findings: [] };
    },
  };
}
