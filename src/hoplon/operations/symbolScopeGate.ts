/**
 * operations/symbolScopeGate.ts — shared symbols-scope diff gate (hcr-002).
 *
 * Single source of truth for the AS-1 symbols-scope comparison used by both
 * auditDiff (disk state) and dryRun (proposed in-memory state).
 *
 * The gate is a TRUE DIFF between the snapshot baseline (file bytes at the
 * snapshot's git ref, read via the versioning adapter) and the evaluated
 * state. Only symbols that actually changed — added (absent from baseline),
 * removed (absent from evaluated state), or modified (verbatim source
 * differs) — are evaluated against the contracted scope. An unchanged
 * out-of-scope sibling produces NO violation; deleting a pre-existing
 * out-of-scope symbol DOES. Deleting or modifying a contracted symbol is
 * permitted (the LLM was authorized to modify within scope, including delete).
 *
 * Baseline fallbacks (fail-closed): gitRef null, or blob absent at a
 * RESOLVABLE snapshot commit (a genuinely new file) → empty baseline (every
 * audited symbol counts as added); baseline unparseable → empty baseline
 * (deletions undetectable in this degenerate case; a caller-signal abort
 * during the baseline parse still propagates, H12). An UNRESOLVABLE snapshot
 * commit (repo/store desync) propagates as a typed adapter failure — never
 * an empty baseline, which would silently disable deletion detection
 * (hcr-009). Any other versioning failure propagates as its classified error.
 *
 * Evidence is never truncated: sourceSlice carries the full verbatim source
 * of the changed symbol (AGENTS.md rule — no agent-facing caps).
 *
 * Import wall: imports only from ../adapters/*, ../contracts/*.
 */

import type { VersioningAdapter } from '../adapters/versioning.js';
import type { CodeIntelligenceAdapter, SyntaxTree } from '../adapters/codeIntelligence.js';
import type { AuditViolation } from '../contracts/audit.js';
import type { ManifestScope } from '../contracts/manifest.js';
import { AdapterError } from '../contracts/errors.js';

// Audited node kinds whitelist (H15 — structural units)
// Only these top-level JS/TS node kinds are subject to scope enforcement.
// Comments, whitespace, JSDoc, semicolon style are NOT in this set and produce
// zero violations — making a pure reformatter pass classify as PASS.

export const AUDITED_NODE_KINDS = new Set([
  'function_declaration',
  'function_expression',
  'arrow_function',
  'class_declaration',
  'method_definition',
  'import_statement',
  'export_statement',
  'export_clause',
  'lexical_declaration',
  'variable_declaration',
]);

export type SymbolChangeType = 'added' | 'removed' | 'modified';

/** A top-level audited symbol with its verbatim source text. */
interface AuditedSymbolSnapshot {
  name: string;
  kind: string;
  byteRange: [number, number];
  text: string;
}

/** One changed symbol name, anchored at its first occurrence. */
interface ChangedSymbol {
  name: string;
  kind: string;
  changeType: SymbolChangeType;
  /** Current-side location for added/modified; baseline-side for removed. */
  byteRange: [number, number];
  /** Full verbatim source (current side for added/modified; baseline for removed). */
  text: string;
}

export type SymbolsManifestScope = Extract<ManifestScope, { kind: 'symbols' }>;

// loadBaselineContent — snapshot baseline bytes via the versioning adapter

/**
 * Read the baseline bytes for `file` at the snapshot's git ref. Returns an
 * empty Uint8Array when the snapshot has no gitRef, or when the file is
 * absent at a resolvable snapshot commit (the file did not exist at snapshot
 * time). isomorphic-git raises the SAME NotFoundError when the snapshot
 * commit itself is unknown (repo/store desync — git gc, wiped repo dir,
 * gitRepoDir misconfig); that case is disambiguated with the adapter's
 * narrow commit probe (readCommitInfo — the same git.readCommit seam
 * diffSnapshotFiles uses in adapters/versioning/snapshotEvidence.ts) and
 * propagates as a typed adapter failure so auditDiff/dryRun fail CLOSED
 * instead of silently losing deletion detection (hcr-009). Any other
 * adapter failure propagates.
 *
 * @throws {AdapterError} kind 'git_read_failed' — the snapshot commit does
 *   not resolve, or any non-NotFound git read failure.
 */
export async function loadBaselineContent(opts: {
  versioning: VersioningAdapter;
  gitRepoDir: string;
  gitRef: string | null;
  file: string;
}): Promise<Uint8Array> {
  const { versioning, gitRepoDir, gitRef, file } = opts;
  if (gitRef === null) return new Uint8Array(0);
  try {
    return await versioning.readBlob(gitRepoDir, gitRef, file);
  } catch (err) {
    if (!_isNotFound(err)) throw err;
    // NotFound is ambiguous. Probe the commit itself: if it resolves, the
    // file is genuinely absent at snapshot time → empty baseline. If it does
    // not, the probe's typed git_read_failed propagates (fail closed).
    await versioning.readCommitInfo({ dir: gitRepoDir, ref: gitRef });
    return new Uint8Array(0);
  }
}

/** isomorphic-git NotFoundError (missing ref or missing blob at ref). */
function _isNotFound(err: unknown): boolean {
  if (!(err instanceof AdapterError) || err.kind !== 'git_read_failed') {
    return false;
  }
  const cause = err.cause as { code?: unknown; name?: unknown } | null | undefined;
  return cause?.code === 'NotFoundError' || cause?.name === 'NotFoundError';
}

// ---------------------------------------------------------------------------
// evaluateSymbolScopeGate — the shared diff gate
// ---------------------------------------------------------------------------

/**
 * Diff the audited top-level symbols of `currentTree` against the parsed
 * baseline and return one out_of_scope_symbol violation per changed symbol
 * name that is not in the contracted scope. Pure: the only adapter call is
 * codeIntelligence.parse on the baseline bytes; never writes.
 *
 * @throws {DOMException} name 'AbortError' — caller's op signal fired during
 *   the baseline parse (timeouts degrade to an empty baseline instead).
 */
export async function evaluateSymbolScopeGate(opts: {
  file: string;
  contractedScope: SymbolsManifestScope;
  codeIntelligence: CodeIntelligenceAdapter;
  currentTree: SyntaxTree;
  currentContent: Uint8Array;
  baselineContent: Uint8Array;
  /** Fresh parse signal (op signal + parse timeout) for the baseline parse. */
  baselineParseSignal: AbortSignal;
}): Promise<AuditViolation[]> {
  const {
    file,
    contractedScope,
    codeIntelligence,
    currentTree,
    currentContent,
    baselineContent,
    baselineParseSignal,
  } = opts;

  const currentSymbols = _collectAuditedSymbols(codeIntelligence, currentTree, currentContent);

  let baselineSymbols: AuditedSymbolSnapshot[] = [];
  if (baselineContent.byteLength > 0) {
    try {
      const baselineTree = await codeIntelligence.parse(file, baselineContent, baselineParseSignal);
      baselineSymbols = _collectAuditedSymbols(codeIntelligence, baselineTree, baselineContent);
    } catch (err) {
      // Caller's op signal fired → propagate to abort the entire operation (H12).
      // Any other failure (timeout, parser error) → empty baseline fallback.
      if (_isAbortError(err) && !_isTimeoutError(err)) {
        throw err;
      }
    }
  }

  const changed = _diffAuditedSymbols(baselineSymbols, currentSymbols);
  const contractedSymbols = new Set(contractedScope.symbols);

  return changed
    .filter((c) => !contractedSymbols.has(c.name))
    .map((c) => _buildViolation(file, c, contractedScope));
}

// ---------------------------------------------------------------------------
// Internals
// ---------------------------------------------------------------------------

function _collectAuditedSymbols(
  codeIntelligence: CodeIntelligenceAdapter,
  tree: SyntaxTree,
  content: Uint8Array,
): AuditedSymbolSnapshot[] {
  const decoder = new TextDecoder('utf-8');
  return codeIntelligence
    .getTopLevelSymbols(tree)
    .filter((sym) => AUDITED_NODE_KINDS.has(sym.kind))
    .map((sym) => ({
      name: sym.name,
      kind: sym.kind,
      byteRange: sym.byteRange,
      text: decoder.decode(content.subarray(sym.byteRange[0], sym.byteRange[1])),
    }));
}

/**
 * Compute the changed symbol names between baseline and current.
 * Deterministic ordering: current-side changes (added/modified) in current
 * AST order first, then removed names in baseline AST order — one entry per
 * changed name, anchored at its first occurrence. A name on both sides is
 * modified when the multiset of its occurrence signatures (node kind +
 * verbatim source) differs; comparing text (not byte offsets) keeps symbols
 * unchanged when a sibling edit shifts their position in the file.
 */
function _diffAuditedSymbols(
  baseline: AuditedSymbolSnapshot[],
  current: AuditedSymbolSnapshot[],
): ChangedSymbol[] {
  const baselineByName = _groupByName(baseline);
  const currentByName = _groupByName(current);
  const changed: ChangedSymbol[] = [];
  const seen = new Set<string>();

  for (const sym of current) {
    if (seen.has(sym.name)) continue;
    seen.add(sym.name);
    const baselineOccurrences = baselineByName.get(sym.name);
    if (baselineOccurrences === undefined) {
      changed.push({ ...sym, changeType: 'added' });
      continue;
    }
    if (!_sameOccurrences(baselineOccurrences, currentByName.get(sym.name)!)) {
      changed.push({ ...sym, changeType: 'modified' });
    }
  }

  for (const sym of baseline) {
    if (seen.has(sym.name)) continue;
    seen.add(sym.name);
    changed.push({ ...sym, changeType: 'removed' });
  }

  return changed;
}

function _groupByName(symbols: AuditedSymbolSnapshot[]): Map<string, AuditedSymbolSnapshot[]> {
  const map = new Map<string, AuditedSymbolSnapshot[]>();
  for (const sym of symbols) {
    const list = map.get(sym.name);
    if (list === undefined) {
      map.set(sym.name, [sym]);
    } else {
      list.push(sym);
    }
  }
  return map;
}

/** Multiset equality of occurrence signatures (kind + verbatim source). */
function _sameOccurrences(
  a: AuditedSymbolSnapshot[],
  b: AuditedSymbolSnapshot[],
): boolean {
  if (a.length !== b.length) return false;
  const sig = (sym: AuditedSymbolSnapshot): string => `${sym.kind} ${sym.text}`;
  const aSigs = a.map(sig).sort();
  const bSigs = b.map(sig).sort();
  return aSigs.every((s, i) => s === bSigs[i]);
}

function _buildViolation(
  file: string,
  changed: ChangedSymbol,
  contractedScope: SymbolsManifestScope,
): AuditViolation {
  const expectedScopeSummary = `[${contractedScope.symbols.join(', ')}]`;
  const removed = changed.changeType === 'removed';
  return {
    kind: 'out_of_scope_symbol',
    path: file,
    symbolName: changed.name,
    nodeKind: changed.kind,
    byteRange: changed.byteRange,
    // Full verbatim source — agent-facing evidence is never truncated.
    sourceSlice: changed.text,
    changeType: changed.changeType,
    expectedScope: contractedScope as ManifestScope,
    message: removed
      ? `Edit deleted ${changed.name} (${changed.kind}) which is not in the contracted scope.`
      : `Edit modified ${changed.name} (${changed.kind}) which is not in the contracted scope.`,
    correction: removed
      ? `Restore ${changed.name} and confine your edits to ${expectedScopeSummary}.`
      : `Revert the modification to ${changed.name} and confine your edits to ${expectedScopeSummary}.`,
  };
}

function _isAbortError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === 'AbortError';
}

function _isTimeoutError(err: unknown): boolean {
  return (err instanceof DOMException || err instanceof Error) && err.name === 'TimeoutError';
}
