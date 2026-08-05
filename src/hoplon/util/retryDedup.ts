/**
 * util/retryDedup.ts — ML5 Structural Equivalence Retry Deduplication.
 *
 * Detects when LLM retry candidates produce structurally equivalent code
 * (same AST shape, only renamed variables / reformatted literals) that would
 * be rejected again for the same reasons.
 *
 * ## Algorithm
 *
 *   1. For each RetryCandidate, sort its file paths lexicographically (H7).
 *   2. Compute canonicalForm(tree, 'structural').hash for every file.
 *   3. Concatenate hashes in sorted-path order, separated by newlines.
 *   4. SHA-256 the concatenation and prefix with `retry-dedup:sha256:`.
 *   5. A candidate with an already-seen composite hash is a duplicate.
 *
 * ## Invariants
 *
 *   H7  — output is deterministic: same candidates in any input order →
 *         same unique / duplicate partition (first-seen wins).
 *   H13 — pure; no I/O beyond the injected parseFn.
 *
 * ## Import wall
 *
 *   Imports only from node:crypto and sibling util files (canonicalForm).
 *   Never imports adapters, engine, contracts, or pipeline layers.
 *
 * ## Purity
 *
 *   All async work is delegated to the injected parseFn.  No filesystem calls,
 *   no tree-sitter adapter construction, no side effects.
 */

import { createHash } from 'node:crypto';
import { canonicalForm } from './canonicalForm.js';
import type { RefinedSyntaxNode } from '../adapters/codeIntelligence/treeSitter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/**
 * A single retry candidate — one attempted solution across possibly
 * multiple files.
 *
 * - `attemptId`: caller-assigned stable identifier for this attempt
 *   (e.g. "attempt-1", a UUID, or a correlation ID).
 * - `files`: map of file path → source text for every file that was
 *   produced by this attempt.  May be a single file or many.
 */
export interface RetryCandidate {
  attemptId: string;
  /** Key: canonical file path. Value: UTF-8 source text of the file. */
  files: Record<string, string>;
}

/**
 * A parseFn that transforms source text + language string into a
 * RefinedSyntaxNode tree root.
 *
 * Matches the signature of CodeIntelligenceAdapter.parse, reduced to only
 * what retryDedup needs: the root node.  Callers typically wrap the adapter:
 *
 * ```ts
 * const parseFn = async (source: string, lang: string) => {
 *   const tree = await ci.parse(`fixture.${lang}`, enc(source));
 *   return tree.rootNode;
 * };
 * ```
 */
export type ParseFn = (source: string, lang: string) => Promise<RefinedSyntaxNode>;

/**
 * Maps a file path to a language identifier (e.g. "ts", "js", "tsx").
 * Used so the parseFn can select the correct grammar.
 */
export type DetectLangFn = (path: string) => string;

// ---------------------------------------------------------------------------
// computeCandidateHash
// ---------------------------------------------------------------------------

/**
 * Compute a stable composite structural hash for a RetryCandidate.
 *
 * Steps:
 *   1. Sort the file paths in the candidate lexicographically.
 *   2. For each file (in sorted order): parse → canonicalForm 'structural' → hash.
 *   3. Concatenate the per-file hashes, one per line (trailing newline on last).
 *   4. SHA-256 the concatenation; return `retry-dedup:sha256:<hex>`.
 *
 * An empty candidate (no files) returns a stable hash over an empty string.
 *
 * @param candidate    The retry candidate to hash.
 * @param parse        Injected parse function; no tree-sitter adapter created here.
 * @param detectLang   Injected language detector for file paths.
 * @returns            `retry-dedup:sha256:<64-char lowercase hex>`
 */
export async function computeCandidateHash(
  candidate: RetryCandidate,
  parse: ParseFn,
  detectLang: DetectLangFn,
): Promise<string> {
  // Sort paths lexicographically (H7 — determinism)
  const sortedPaths = Object.keys(candidate.files).sort();

  const perFileHashes: string[] = [];

  for (const filePath of sortedPaths) {
    const source = candidate.files[filePath]!;
    const lang = detectLang(filePath);
    const rootNode = await parse(source, lang);
    const form = canonicalForm(rootNode, 'structural');
    // form.hash is 'sha256:<hex>' — include the prefix so the concatenation
    // is unambiguous and self-describing.
    perFileHashes.push(form.hash);
  }

  // Join with newlines; even empty candidates get a stable (empty) input.
  const concatenation = perFileHashes.join('\n');
  const hexDigest = createHash('sha256').update(concatenation, 'utf8').digest('hex');
  return `retry-dedup:sha256:${hexDigest}`;
}

// ---------------------------------------------------------------------------
// dedupRetryAttempts
// ---------------------------------------------------------------------------

/**
 * Deduplicate a list of retry candidates by structural equivalence.
 *
 * First occurrence of a composite hash is kept as unique.  Subsequent
 * candidates with the same hash are duplicates, each mapped back to the
 * `attemptId` of the first candidate that produced that hash.
 *
 * Input order is preserved for the unique list; duplicates carry the order
 * in which they were encountered.
 *
 * @param candidates    Ordered list of retry candidates to inspect.
 * @param parseFn       Injected parse function.
 * @param detectLangFn  Injected language detector.
 * @returns             `{ unique, duplicates }` — see type below.
 */
export async function dedupRetryAttempts(
  candidates: RetryCandidate[],
  parseFn: ParseFn,
  detectLangFn: DetectLangFn,
): Promise<{
  unique: RetryCandidate[];
  duplicates: Array<{ candidate: RetryCandidate; equivalentTo: string }>;
}> {
  const unique: RetryCandidate[] = [];
  const duplicates: Array<{ candidate: RetryCandidate; equivalentTo: string }> = [];

  // Map from composite hash → attemptId of the first candidate that produced it
  const seen = new Map<string, string>();

  for (const candidate of candidates) {
    const hash = await computeCandidateHash(candidate, parseFn, detectLangFn);

    const prior = seen.get(hash);
    if (prior === undefined) {
      seen.set(hash, candidate.attemptId);
      unique.push(candidate);
    } else {
      duplicates.push({ candidate, equivalentTo: prior });
    }
  }

  return { unique, duplicates };
}
