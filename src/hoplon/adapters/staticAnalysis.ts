/**
 * adapters/staticAnalysis.ts — StaticAnalysisAdapter interface (optional).
 *
 * Phase 1 default: createNoopAnalyzer() — returns PASS with empty findings.
 * Phase 4 swap target: Semgrep via @phalanx/hoplon-static-analysis-semgrep.
 *   Semgrep is LGPL — ships as a separate plugin package, never bundled into core.
 *
 * This adapter is optional; the engine substitutes a noop when absent.
 */

// ---------------------------------------------------------------------------
// AnalysisFinding — placeholder shape
// ---------------------------------------------------------------------------

export interface AnalysisFinding {
  path: string;
  rule: string;
  message: string;
  severity: 'info' | 'warning' | 'error';
}

// ---------------------------------------------------------------------------
// StaticAnalysisAdapter interface
// ---------------------------------------------------------------------------

export interface StaticAnalysisAdapter {
  /**
   * Run static analysis over the given files.
   * Returns PASS when no blocking findings exist, BLOCK otherwise.
   * The noop implementation always returns PASS with empty findings.
   */
  analyze(req: { files: string[] }): Promise<{
    status: 'PASS' | 'BLOCK';
    findings: AnalysisFinding[];
  }>;
}
