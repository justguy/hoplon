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

import type { FindReferencingSymbolsRequest, FindReferencingSymbolsResult } from '../contracts/referencingSymbols.js';
import type { FindSyntaxNodeRequest, FindSyntaxNodeResult } from '../contracts/syntaxNodeLookup.js';
import type { SynthesizeInterfaceStubsRequest, SynthesizeInterfaceStubsResult } from '../contracts/interfaceStubs.js';
import type { EphemeralStructuralSandboxRequest, EphemeralStructuralSandboxResult } from '../contracts/structuralSandbox.js';
import type { IndexSemanticCorpusRequest, IndexSemanticCorpusResult, SemanticOverlayClearRequest, SemanticOverlayClearResult, SemanticOverlayRefreshRequest, SemanticOverlayRefreshResult, SemanticSearchRequest, SemanticSearchResult } from '../contracts/semanticSearch.js';

// ---------------------------------------------------------------------------

export interface HoplonEngineOperationsPart03 {
  /**
   * t-118 — advisory referencing-symbol lookup over the optional
   * CodeIntelligenceAdapter.findReferences seam.
   *
   * Resolves either a direct symbol identity or a symbol query and returns
   * reference locations plus containing symbols when the host-bound provider
   * is available. The shipped tree-sitter default does not implement
   * findReferences, so the method reports UNAVAILABLE without fabricating
   * cross-file data. It never feeds auditDiff, dryRun, preflight, or any other
   * PASS/BLOCK path.
   */
  findReferencingSymbols(
    req: FindReferencingSymbolsRequest,
    signal?: AbortSignal,
  ): Promise<FindReferencingSymbolsResult>;

  /**
   * t-120 — advisory Tree-sitter syntax-node lookup.
   *
   * Resolves a supported source file location by UTF-8 byte offset/range or
   * row/column position and returns typed Hoplon node summaries plus parser
   * health metadata. It never exposes native Tree-sitter handles and never
   * feeds auditDiff, dryRun, preflight, policy, or any PASS/BLOCK path.
   */
  findSyntaxNode(
    req: FindSyntaxNodeRequest,
    signal?: AbortSignal,
  ): Promise<FindSyntaxNodeResult>;

  /**
   * t-028 — deterministic interface-stub synthesis over manifest-truth
   * `SignatureContracts`.
   *
   * For each caller-supplied `(file, symbol)` target, emits either an
   * authoritative `export declare function ...;` declaration (one line per
   * matching SignatureContract in source order) or an explicitly partial
   * `export declare const <symbol>: unknown;` placeholder with a closed-enum
   * `reason` when no contract matches. Duplicate targets collapse to one
   * stub per `(file, symbol)`.
   *
   * Strictly advisory:
   *   - `result.advisory` is schema-pinned to `true`; the engine boundary
   *     re-validates the result so the flag cannot silently flip.
   *   - No PASS/BLOCK path (`auditDiff`, `createSnapshot`, `dryRun`,
   *     `preflight`) consults this method.
   *   - Pure string transform over the Zod-validated request; no
   *     `CodeIntelligenceAdapter` call, no `ts-morph`, no dependency addition.
   *
   * Deterministic (H7): stubs are sorted by `(target.file, target.symbol)`.
   * H13: emitter events carry counts only — never symbol names, type strings,
   * or declaration bodies.
   */
  synthesizeInterfaceStubs(
    req: SynthesizeInterfaceStubsRequest,
    signal?: AbortSignal,
  ): Promise<SynthesizeInterfaceStubsResult>;

  /**
   * t-108 - read-only in-memory structural sandbox for synthetic snippets.
   *
   * This is a planning macro only. It parses caller-supplied content through a
   * detached AST context and reports parse/structure compatibility. It never
   * reads or writes project files, never touches versioning, snapshots, audit
   * log, session state, or locks, and its result cannot authorize writes or
   * replace dryRun, auditDiff, policy checks, or session_apply_edits.
   */
  ephemeralStructuralSandbox(
    req: EphemeralStructuralSandboxRequest,
    signal?: AbortSignal,
  ): Promise<EphemeralStructuralSandboxResult>;

  /**
   * t-034 — first real Layer 1 semantic-search retrieval consumer.
   *
   * Embeds the caller-supplied query through the configured `EmbeddingAdapter`
   * and retrieves the top-K most similar documents from the configured
   * `VectorStoreAdapter`, scoped to the caller's `projectId`.
   *
   * Strictly advisory:
   *   - `result.advisory` is schema-pinned to `true`; the engine boundary
   *     rejects any result that tries to flip it.
   *   - No PASS/BLOCK path (`auditDiff`, `createSnapshot`, `dryRun`,
   *     `preflight`) consults this method.
   *   - When either slot is still bound to its built-in noop the operation
   *     returns `status: 'UNAVAILABLE'` with `providerAvailable: false` and an
   *     empty `matches` array. It never throws for missing providers and
   *     never fabricates matches.
   *
   * Project scoping is enforced twice — the operation passes `{projectId}`
   * as a metadata filter to `vectorStore.search` AND re-verifies the returned
   * records on the client side — so cross-project leakage is not possible
   * regardless of whether the adapter honours the filter.
   */
  semanticSearch(
    req: SemanticSearchRequest,
    signal?: AbortSignal,
  ): Promise<SemanticSearchResult>;

  /**
   * Refresh process-local, session-scoped semantic overlay rows consumed by
   * semanticSearch when a caller supplies sessionId. Advisory only: no
   * deterministic PASS/BLOCK path consults this data.
   */
  refreshSemanticOverlay(
    req: SemanticOverlayRefreshRequest,
    signal?: AbortSignal,
  ): Promise<SemanticOverlayRefreshResult>;

  /**
   * Discard process-local session overlay rows on lifecycle boundaries such
   * as revert and close. Advisory cleanup only.
   */
  clearSemanticOverlay(
    req: SemanticOverlayClearRequest,
    signal?: AbortSignal,
  ): Promise<SemanticOverlayClearResult>;

  /**
   * t-034 — project-scoped semantic corpus indexing seam.
   *
   * For each caller-supplied document, embeds the text via the configured
   * `EmbeddingAdapter` and upserts `{id, vector, metadata: {…, projectId}}`
   * through the configured `VectorStoreAdapter`. Documents whose embedding
   * yields an empty vector are silently skipped (unindexable input degrades
   * to "no signal" rather than throwing).
   *
   * Like `semanticSearch`, this operation returns `status: 'UNAVAILABLE'`
   * with `indexedCount: 0` when either slot is still bound to its built-in
   * noop; it never writes anything in that state.
   */
  indexSemanticCorpus(
    req: IndexSemanticCorpusRequest,
    signal?: AbortSignal,
  ): Promise<IndexSemanticCorpusResult>;
}
