/**
 * tests/concurrency/parserWorkerSerialize.test.ts — GAP G1 regression.
 *
 * serializeTree must visit each tree-sitter node exactly once. The prior
 * implementation recursed into node.child(i) AND node.namedChild(i); because
 * named children are a subset of all children, every named node was visited
 * (and re-expanded) twice, producing exponential growth in the flat node array
 * for deeply nested named ASTs.
 *
 * These tests assert on the *size* of the serialized output (visit count), not
 * wall-clock time, so they are deterministic.
 */

import { describe, it, expect } from 'vitest';
import type { Node as TSNode } from 'web-tree-sitter';
import { serializeTree } from '../../src/hoplon/concurrency/parserWorker.js';

/**
 * Minimal mock tree-sitter node. Children are the full child list; named
 * children are the subset flagged `named`. Mirrors how a real grammar exposes
 * a single named child at each level (e.g. an expression wrapping an
 * expression wrapping ...).
 */
interface MockNode {
  type: string;
  startIndex: number;
  endIndex: number;
  text: string;
  named: boolean;
  children: MockNode[];
}

function toTSNode(node: MockNode): TSNode {
  const named = node.children.filter((c) => c.named);
  return {
    type: node.type,
    startIndex: node.startIndex,
    endIndex: node.endIndex,
    text: node.text,
    isNamed: node.named,
    childCount: node.children.length,
    namedChildCount: named.length,
    child: (i: number) => {
      const c = node.children[i];
      return c ? toTSNode(c) : null;
    },
    namedChild: (i: number) => {
      const c = named[i];
      return c ? toTSNode(c) : null;
    },
  } as unknown as TSNode;
}

/** Build a chain of `depth` nodes, each a single *named* child of its parent. */
function buildDeepNamedChain(depth: number): MockNode {
  let current: MockNode = {
    type: 'leaf',
    startIndex: 0,
    endIndex: 1,
    text: 'x',
    named: true,
    children: [],
  };
  for (let i = 1; i < depth; i++) {
    current = {
      type: `wrap_${i}`,
      startIndex: 0,
      endIndex: 1,
      text: 'x',
      named: true,
      children: [current],
    };
  }
  return current;
}

describe('GAP G1 — serializeTree visits each node exactly once', () => {
  it('deeply nested named AST serializes in linear size (no exponential blowup)', () => {
    // depth=20 → linear serialization yields 20 nodes. The prior double-visit
    // implementation yields 2^20 - 1 = 1,048,575 nodes, a clean, deterministic
    // mismatch (and at larger depths simply OOMs).
    const depth = 20;
    const root = toTSNode(buildDeepNamedChain(depth));

    const { nodes, rootIndex } = serializeTree(root, 'x');

    // Exactly one flat node per source node — not 2^depth.
    expect(nodes.length).toBe(depth);
    expect(rootIndex).toBe(0);
  });

  it('named child indexes reference the same visited nodes as childIndexes', () => {
    // parent with two children: one named, one anonymous (e.g. punctuation).
    const parent: MockNode = {
      type: 'parent',
      startIndex: 0,
      endIndex: 3,
      text: 'a;b',
      named: true,
      children: [
        { type: 'ident', startIndex: 0, endIndex: 1, text: 'a', named: true, children: [] },
        { type: ';', startIndex: 1, endIndex: 2, text: ';', named: false, children: [] },
        { type: 'ident', startIndex: 2, endIndex: 3, text: 'b', named: true, children: [] },
      ],
    };
    const { nodes, rootIndex } = serializeTree(toTSNode(parent), 'a;b');

    // 1 parent + 3 children, each visited once.
    expect(nodes.length).toBe(4);
    const rootNode = nodes[rootIndex]!;
    expect(rootNode.childIndexes).toEqual([1, 2, 3]);
    // named children are the two idents — same indexes, not fresh duplicates.
    expect(rootNode.namedChildIndexes).toEqual([1, 3]);
    // every namedChildIndex must be one of the childIndexes (a subset).
    for (const ni of rootNode.namedChildIndexes) {
      expect(rootNode.childIndexes).toContain(ni);
    }
  });

  it('byte ranges and kinds survive the single-visit restructuring', () => {
    const parent: MockNode = {
      type: 'root',
      startIndex: 0,
      endIndex: 2,
      text: 'ab',
      named: true,
      children: [
        { type: 'a', startIndex: 0, endIndex: 1, text: 'a', named: true, children: [] },
      ],
    };
    const { nodes } = serializeTree(toTSNode(parent), 'ab');
    expect(nodes[0]!.kind).toBe('root');
    expect(nodes[0]!.byteRange).toEqual([0, 2]);
    expect(nodes[1]!.kind).toBe('a');
    expect(nodes[1]!.byteRange).toEqual([0, 1]);
  });
});
