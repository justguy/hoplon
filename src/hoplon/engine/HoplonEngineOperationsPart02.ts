/**
 * engine/types.ts — HoplonEngine interface, HoplonAdapters, HoplonEngineConfig.
 *
 * All public methods return Promise<T> (invariant H3 — no callbacks, no event emitters).
 * Every async method accepts an optional AbortSignal (H12).
 * The engine never owns retry or escalation policy (invariant H4).
 *
 * EXCEPTIONS (synchronous methods):
 *   compressRetryContext — pure data transform over AuditViolation arrays (recs §15.9, LC9).
 *   computeMinimalPatch  — pure byte-range arithmetic over violation data (recs §15.5, LC5).
 * Both are no-I/O, no-async functions that return values directly (not Promises).
 */

import type { GetRelevantTestsRequest, TestOracleResult } from '../contracts/getRelevantTests.js';
import type { ExtractRollbackTemplateRequest, RollbackTemplate } from '../contracts/rollbackTemplate.js';
import type { SearchSymbolsRequest, SearchSymbolsResult } from '../contracts/searchSymbols.js';
import type { DescribeProjectRequest, DescribeProjectResult } from '../contracts/describeProject.js';
import type { SeeCodebaseEnvelope, SeeCodebaseRequest } from '../contracts/seeCodebase.js';
import type { ScoreAnomalyRequest, AnomalyScore } from '../contracts/anomalyDetector.js';
import type { AnalyzeBlastRadiusRequest, AnalyzeBlastRadiusResult } from '../contracts/blastRadius.js';
import type { PredictViolationRiskRequest, ViolationPrediction } from '../contracts/violationPredictor.js';

// ---------------------------------------------------------------------------

export interface HoplonEngineOperationsPart02 {
  /**
   * Determine which test files import the given modified files, directly or
   * transitively within maxDepth hops (default: 2).
   *
   * Uses tree-sitter import graph BFS (CI3-3 queryStructure) — no LLM call,
   * no runtime required. Pure static analysis on the current filesystem state.
   *
   * Returns:
   *   - relevantTests       — sorted test file paths that reach ≥1 modifiedFile
   *   - coverageConfidence  — 'exact' or 'conservative' (if dynamic require() detected)
   *   - unusedModifiedFiles — sorted modified files not imported by any test (dead code signal)
   *
   * (recs §15.10, plan § Slice LC10)
   */
  getRelevantTests(
    req: GetRelevantTestsRequest,
    signal?: AbortSignal,
  ): Promise<TestOracleResult>;

  /**
   * Extract per-file structural rollback templates from a committed snapshot.
   *
   * Composes extractStructuralTemplate (LC4) in snapshot mode to produce
   * a structural skeleton of the reverted state for each requested file.
   * Returns per-file contractedChanges descriptions and a non-empty
   * injectionHint for the retry prompt.
   *
   * Call this immediately after revertUncontracted() to get the positive
   * reference structure ("here is exactly how the file looked before your
   * failed edit") for injection alongside violation descriptions.
   *
   * Returns:
   *   - files[].structuralSkeleton  — compact serialized exports/imports/types
   *   - files[].contractedChanges   — what the manifest scope permitted for this file
   *   - files[].injectionHint       — directive sentence (always non-empty)
   *   - snapshotRef                 — the snapshot the skeletons were read from
   *   - generatedAt                 — ISO 8601 wall-clock timestamp
   *
   * Deterministic (H7): same (snapshotRefId, files, contractedChangesMap) → byte-identical
   * structuralSkeleton (generatedAt timestamp differs across calls by design).
   *
   * (recs §15.11, plan § Slice LC11)
   */
  extractRollbackTemplate(
    req: ExtractRollbackTemplateRequest,
    signal?: AbortSignal,
  ): Promise<RollbackTemplate>;

  /**
   * t-056 — Local AST-aware structural search across the project.
   *
   * Filters tree-sitter declarations (functions, classes, methods, exports,
   * top-level type/interface/enum names) by a caller-supplied regex. The
   * operation is read-only and intentionally narrower than text grep: it
   * only finds *declared* symbols, never raw substrings inside docs,
   * comments, env vars, JSON config, or arbitrary string literals.
   *
   * Deterministic (H7): matches sorted by `(path, name, byteRange[0])`.
   * Bounded (H15): `maxResults` caps the response; `truncated` reports it.
   */
  searchSymbols(
    req: SearchSymbolsRequest,
    signal?: AbortSignal,
  ): Promise<SearchSymbolsResult>;

  /**
   * t-056 — Local AST-aware project orientation.
   *
   * Walks the project tree, classifies JS/TS files by tree-sitter grammar,
   * and aggregates structural counts (exports, imports, types, functions,
   * classes) over a deterministic alphabetical sample bounded by
   * `maxFiles`. Returns counts and per-language sample paths so callers
   * can orient without reading every file.
   *
   * Read-only. Does not extend to non-JS/TS languages, dependency-graph
   * analysis, or quality scoring — those are separate follow-on lanes.
   */
  describeProject(
    req: DescribeProjectRequest,
    signal?: AbortSignal,
  ): Promise<DescribeProjectResult>;

  /**
   * t-061 — Unified agent-facing read/search macro.
   *
   * Composes the existing structural primitives (`packContext`,
   * `extractStructuralTemplate`, `searchSymbols`, `describeProject`)
   * with Hoplon-owned raw file read + raw text search
   * behind one envelope with `mode: auto|structural|raw|skeleton`.
   *
   * Auto routing uses request intent plus file-kind support, never
   * extension-only heuristics. `mode: skeleton` reuses
   * `extractStructuralTemplate` — it is NOT a parallel compression
   * mechanism. `strict: true` blocks silent fallback between structural,
   * skeleton, and raw paths.
   *
   * The response envelope carries `provenance` with selected path,
   * routing reason, underlying primitives, fallback flags, and latency /
   * bytes metrics for `t-064` benchmark bucketing. Errors surface as
   * `{ ok: false, error }` envelopes (not thrown) so MCP / CLI / HTTP
   * callers see structured blocks.
   */
  seeCodebase(
    req: SeeCodebaseRequest,
    signal?: AbortSignal,
  ): Promise<SeeCodebaseEnvelope>;

  /**
   * t-036 — advisory violation-risk predictor seam.
   *
   * Consumes caller-supplied historical `AuditLogRecord[]` rows (and optional
   * proposed numeric features) and returns a `ViolationPrediction` whose
   * `advisory: true` literal is a hard schema invariant. The method never
   * writes to `hoplon_audit_log`, never participates in `auditDiff` semantics,
   * and never changes the engine's PASS/BLOCK result for any other operation.
   *
   * Scope is deliberately narrow: Hoplon exposes the seam and a noop default;
   * the host wires a real predictor (e.g. `createBaseRateViolationPredictor`)
   * and decides how to source history. Any promotion to blocking behavior is
   * a separate, out-of-scope slice.
   */
  predictViolationRisk(
    req: PredictViolationRiskRequest,
    signal?: AbortSignal,
  ): Promise<ViolationPrediction>;

  /**
   * t-037 — advisory anomaly-detector seam.
   *
   * Consumes caller-supplied historical `AuditLogRecord[]` rows (and optional
   * proposed project metrics) and returns an `AnomalyScore` whose
   * `advisory: true` literal is a hard schema invariant. The method never
   * writes to `hoplon_audit_log`, never participates in `auditDiff` semantics,
   * and never changes the engine's PASS/BLOCK result for any other operation.
   *
   * Hoplon ships the seam with a noop default plus an opt-in statistical
   * detector (`createStatisticalAnomalyDetector`). Hosts choose the binding
   * and decide how to source history. Any promotion to blocking behavior is
   * a separate, out-of-scope slice.
   */
  scoreAnomaly(
    req: ScoreAnomalyRequest,
    signal?: AbortSignal,
  ): Promise<AnomalyScore>;

  /**
   * t-027 — advisory blast-radius consumer over the optional
   * `CodeIntelligenceAdapter.findReferences` seam.
   *
   * For each caller-supplied symbol, returns the number of cross-file
   * references, the distinct affected files, and a `safe | warning |
   * missing_provider` classification against the explicit warn threshold.
   *
   * Strictly advisory:
   *   - `result.advisory` is schema-pinned to `true`; the engine boundary
   *     rejects any result that tries to flip it.
   *   - No PASS/BLOCK path (`auditDiff`, `createSnapshot`, `dryRun`,
   *     `preflight`) consults this method.
   *   - When the configured CodeIntelligence adapter does not implement
   *     `findReferences` (e.g. the shipped tree-sitter default on its own),
   *     the operation returns `status: 'UNAVAILABLE'` with every entry
   *     classified `missing_provider`. It never throws for missing providers
   *     and never fabricates cross-file counts.
   *
   * Tree-sitter remains the shipped default intelligence path; this method
   * is an additive Layer 2 consumer that becomes useful once the host wires
   * an LSP/SCIP-backed adapter that implements `findReferences`.
   */
  analyzeBlastRadius(
    req: AnalyzeBlastRadiusRequest,
    signal?: AbortSignal,
  ): Promise<AnalyzeBlastRadiusResult>;
}
