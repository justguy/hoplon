/**
 * util/canonicalForm.ts — CF1 Canonical Form computation.
 *
 * Reduces a RefinedSyntaxNode tree to a stable, serialized canonical form.
 * Two modes:
 *
 * ## Structural mode
 *   Strips all identifier names and normalizes literals to type-only
 *   placeholders. Answers: "are these two trees the same shape?" Renamed
 *   variables and renamed functions produce the same structural hash.
 *   Used by ML §16.2 structural equivalence detection.
 *
 * ## Signature mode
 *   Preserves identifiers but strips whitespace and comment nodes. Answers:
 *   "is this the contracted symbol?" Used in auditDiff comparison.
 *
 * ## Idempotency invariant
 *   `stableStringify(toCanonical(tree, mode)) === stableStringify(toCanonical(tree, mode))`
 *   is trivially true for a pure function. The stronger proof is:
 *   `JSON.parse(form.serialized)` re-serialized with stableStringify equals
 *   `form.serialized` — i.e., the output is already in a canonical stable form.
 *   This is guaranteed because toCanonical returns a plain POJO and
 *   stableStringify normalizes key order.
 *
 * ## H7 compliance (determinism)
 *   Output is deterministic: same tree, same mode → same hash, same serialized
 *   string, on any machine and any call. No wall-clock or random state.
 *
 * ## H13 compliance
 *   The canonical form is a pure data structure transformation. It does not
 *   emit any events. Callers that need structural hashes for observability
 *   should emit structure-only counts, never the serialized form itself.
 *
 * ## H20 note
 *   canonicalForm operates on RefinedSyntaxNode, which already carries UTF-8
 *   byte ranges (H20 guarantee from treeSitter.ts). We include byteRange in
 *   structural mode only when it is meaningfully distinct (leaf nodes). For
 *   the structural hash we intentionally EXCLUDE byteRange so that two
 *   structurally-equivalent trees at different offsets hash identically.
 *
 * ## Import wall
 *   Imports only from ./stableStringify.js and node:crypto.
 *   Never imports adapters, engine, contracts, or pipeline layers.
 */

import { createHash } from 'node:crypto';
import { stableStringify } from './stableStringify.js';
import type { RefinedSyntaxNode } from '../adapters/codeIntelligence/treeSitter.js';

// ---------------------------------------------------------------------------
// Public types
// ---------------------------------------------------------------------------

/** Mode of canonical form computation. */
export type CanonicalFormMode = 'structural' | 'signature';

/**
 * Output of canonicalForm.
 *
 * - `mode`: which normalization was applied.
 * - `serialized`: stableStringify of the CanonicalNode tree. Parsing this
 *   JSON and re-serializing with stableStringify yields the same string
 *   (idempotency proof anchor).
 * - `hash`: `sha256:<hex>` digest of `serialized`. Stable content-addressable
 *   identifier for the canonical form.
 */
export interface SerializedCanonicalForm {
  mode: CanonicalFormMode;
  /** Stable JSON serialization of the normalized tree. Key order is sorted. */
  serialized: string;
  /** `sha256:<64-char lowercase hex>` — content-addressable hash of `serialized`. */
  hash: string;
}

// ---------------------------------------------------------------------------
// Internal: canonical node representation
// ---------------------------------------------------------------------------

/**
 * A normalized, serializable node.
 *
 * - `k`: node kind (tree-sitter `type` field)
 * - `c`: children array (named children only in both modes)
 * - `v` (optional): preserved text value (identifiers in signature mode; absent in structural)
 *
 * The shape is intentionally minimal: no byteRange (excludes position from
 * structural hash), no `text` on internal nodes, no circular refs.
 */
interface CanonicalNode {
  k: string;
  c: CanonicalNode[];
  v?: string;
}

// ---------------------------------------------------------------------------
// Node classification helpers
// ---------------------------------------------------------------------------

/**
 * Node kinds that represent identifiers.
 * In structural mode: stripped (no `v` field).
 * In signature mode: preserved (include `v` field).
 *
 * These are the tree-sitter grammar kinds used by JavaScript, TypeScript,
 * and TSX grammars loaded by createTreeSitterIntelligence.
 */
const IDENTIFIER_KINDS = new Set<string>([
  'identifier',
  'type_identifier',
  'property_identifier',
  'shorthand_property_identifier',
  'shorthand_property_identifier_pattern',
  'private_property_identifier',
  'statement_identifier',
  // TypeScript-specific
  'predefined_type',
]);

/**
 * Node kinds that represent string literals.
 * In structural mode: replaced with kind placeholder (no children, no text).
 */
const STRING_LITERAL_KINDS = new Set<string>([
  'string',
  'template_string',
  'template_literal',
  'jsx_text',
]);

/**
 * Node kinds that represent numeric literals.
 * In structural mode: replaced with kind placeholder.
 */
const NUMBER_LITERAL_KINDS = new Set<string>([
  'number',
]);

/**
 * Node kinds that are whitespace or formatting only.
 * In both modes: skipped (they carry no structural or signature information).
 * tree-sitter typically doesn't surface these as named children, but guard
 * defensively in case an anonymous node leaks through the facade.
 */
const WHITESPACE_KINDS = new Set<string>([
  'whitespace',
  // Anonymous token kinds (only appear as anonymous children, never named)
]);

/**
 * Node kinds that represent comments.
 * In signature mode: stripped (removed from children array).
 * In structural mode: also stripped (comments are not structural).
 */
const COMMENT_KINDS = new Set<string>([
  'comment',
  'line_comment',
  'block_comment',
  'hash_bang_line',
]);

// ---------------------------------------------------------------------------
// Core normalization
// ---------------------------------------------------------------------------

/**
 * Walk a RefinedSyntaxNode tree and produce a CanonicalNode tree.
 *
 * In structural mode:
 *   - Comments, whitespace: dropped
 *   - Identifier nodes: kind preserved, text dropped (no `v`)
 *   - String literal nodes: kind preserved as `string_literal`, no children, no text
 *   - Number literal nodes: kind preserved as `number_literal`, no children, no text
 *   - All other nodes: kind preserved, children recursed
 *
 * In signature mode:
 *   - Comments, whitespace: dropped
 *   - Identifier nodes: kind + text preserved
 *   - String/number literals: kind + text preserved
 *   - All other nodes: kind preserved, children recursed
 *
 * In both modes we recurse into `namedChildren` only (tree-sitter's named
 * children are the semantically meaningful nodes; anonymous nodes like
 * punctuation are excluded).
 */
function toCanonical(node: RefinedSyntaxNode, mode: CanonicalFormMode): CanonicalNode | null {
  const { kind } = node;

  // Drop comments in both modes — they carry no structural or signature info.
  if (COMMENT_KINDS.has(kind)) return null;

  // Drop pure-whitespace nodes (guard; normally not in namedChildren).
  if (WHITESPACE_KINDS.has(kind)) return null;

  if (mode === 'structural') {
    // String literals → collapsed placeholder
    if (STRING_LITERAL_KINDS.has(kind)) {
      return { k: 'string_literal', c: [] };
    }

    // Number literals → collapsed placeholder
    if (NUMBER_LITERAL_KINDS.has(kind)) {
      return { k: 'number_literal', c: [] };
    }

    // Identifier nodes → preserve kind, strip name
    if (IDENTIFIER_KINDS.has(kind)) {
      return { k: kind, c: [] };
    }

    // All other nodes → recurse into named children
    const children = _recurse(node.namedChildren, mode);
    return { k: kind, c: children };
  }

  // signature mode: preserve identifiers and literal text, strip comments
  if (IDENTIFIER_KINDS.has(kind)) {
    return { k: kind, c: [], v: node.text };
  }

  if (STRING_LITERAL_KINDS.has(kind) || NUMBER_LITERAL_KINDS.has(kind)) {
    // Preserve literal value in signature mode (it may be part of a signature)
    return { k: kind, c: [], v: node.text };
  }

  // All other nodes → recurse
  const children = _recurse(node.namedChildren, mode);
  return { k: kind, c: children };
}

/** Recurse into an array of named children, filtering nulls. */
function _recurse(nodes: RefinedSyntaxNode[], mode: CanonicalFormMode): CanonicalNode[] {
  const result: CanonicalNode[] = [];
  for (const child of nodes) {
    const canonical = toCanonical(child, mode);
    if (canonical !== null) {
      result.push(canonical);
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Compute the canonical form of a syntax tree.
 *
 * @param tree  Root node from `codeIntelligence.parse(...)`.
 *              Pass `tree.rootNode` (the `RefinedSyntaxNode`) directly.
 *              For structural equivalence of a whole file, pass the `program`
 *              (root) node. For signature comparison of a single function, pass
 *              the function node.
 * @param mode  'structural' | 'signature' — see module doc.
 * @returns     SerializedCanonicalForm with `mode`, `serialized`, and `hash`.
 *
 * @example
 * ```ts
 * const tree = await ci.parse('src/foo.ts', content);
 * const form = canonicalForm(tree.rootNode, 'structural');
 * // form.hash: 'sha256:<hex>'
 * // form.serialized: stableJSON of canonical tree
 * ```
 */
export function canonicalForm(
  tree: RefinedSyntaxNode,
  mode: CanonicalFormMode,
): SerializedCanonicalForm {
  const canonical = toCanonical(tree, mode) ?? { k: tree.kind, c: [] };
  const serialized = stableStringify(canonical);
  const hexDigest = createHash('sha256').update(serialized, 'utf8').digest('hex');
  const hash = `sha256:${hexDigest}`;
  return { mode, serialized, hash };
}
