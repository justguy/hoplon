/**
 * tests/util/astMerge.test.ts — t-040 Multi-agent AST merge targeted test suite.
 *
 * Proof requirements (from slice spec):
 *
 *   AM-1  Two non-overlapping edits in the same file → merged successfully;
 *         final content has both.
 *
 *   AM-2  Two overlapping byte-identical edits → merged successfully (idempotent
 *         dedup); only one edit applied, result is byte-identical to single edit.
 *
 *   AM-3  Two overlapping non-equivalent edits → ConflictDescriptor returned with
 *         both edits.
 *
 *   AM-4  Two edits in different files → both files in `merged`.
 *
 *   AM-5  Apply order: right-to-left within a file (later byte offset applied
 *         first so earlier offsets stay valid).
 *
 *   AM-6  equivalenceCheck injection: when injected returns true, "different but
 *         equivalent" replacements merge as one (no conflict).
 *
 *   AM-7  Empty edit list → success with empty merged map.
 *
 *   AM-8  H7 determinism: same input → byte-identical merged output.
 *
 * Test infrastructure:
 *   - No real filesystem, no tree-sitter, no adapters.
 *   - All inputs are plain ASCII strings.
 */

import { describe, it, expect } from 'vitest';

import {
  mergeAstEdits,
} from '../../src/hoplon/util/astMerge.js';
import type {
  AstEdit,
  MergeResultSuccess,
  MergeResultConflict,
} from '../../src/hoplon/util/astMerge.js';

// ---------------------------------------------------------------------------
// Helper: build an AstEdit
// ---------------------------------------------------------------------------

function edit(
  agentId: string,
  filePath: string,
  start: number,
  end: number,
  replacement: string,
  kind?: string,
): AstEdit {
  return {
    agentId,
    filePath,
    node: { byteRange: [start, end], kind },
    replacement,
  };
}

// ---------------------------------------------------------------------------
// AM-7  Empty edit list
// ---------------------------------------------------------------------------

describe('mergeAstEdits', () => {
  it('AM-7: empty edit list → success with empty merged map', async () => {
    const result = await mergeAstEdits([], {});
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    expect(Object.keys(success.merged)).toHaveLength(0);
  });

  // ---------------------------------------------------------------------------
  // AM-1  Two non-overlapping edits in the same file
  // ---------------------------------------------------------------------------

  it('AM-1: two non-overlapping edits in the same file → both applied, merged contains result', async () => {
    // Original: "Hello World!"
    //           0123456789012
    // Edit A replaces "Hello" (0..5) → "Hi"
    // Edit B replaces "World" (6..11) → "Earth"
    const original = 'Hello World!';
    const edits: AstEdit[] = [
      edit('agent-a', 'file.ts', 0, 5, 'Hi'),
      edit('agent-b', 'file.ts', 6, 11, 'Earth'),
    ];
    const result = await mergeAstEdits(edits, { 'file.ts': original });
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    expect(success.merged['file.ts']).toBe('Hi Earth!');
  });

  // ---------------------------------------------------------------------------
  // AM-5  Right-to-left apply order
  // ---------------------------------------------------------------------------

  it('AM-5: edits applied right-to-left so earlier byte offsets stay valid', async () => {
    // Original: "ABCDEF"
    //            012345
    // Edit 1 replaces chars 0..2 (AB) with "XX"
    // Edit 2 replaces chars 3..5 (DE) with "YY"
    // If applied left-to-right, editing 0..2 first shifts indices for 3..5
    // → applying 3..5 on the modified string hits wrong bytes.
    // Right-to-left: edit 3..5 first → "ABCYYF", then 0..2 → "XXCYYF"
    const original = 'ABCDEF';
    const edits: AstEdit[] = [
      edit('agent-a', 'file.ts', 0, 2, 'XX'),
      edit('agent-b', 'file.ts', 3, 5, 'YY'),
    ];
    const result = await mergeAstEdits(edits, { 'file.ts': original });
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    expect(success.merged['file.ts']).toBe('XXCYYF');
  });

  it('AM-5: right-to-left order is byte-position-based, not input-array-order', async () => {
    // Same as above but edits provided in reverse input order → same result.
    const original = 'ABCDEF';
    const edits: AstEdit[] = [
      edit('agent-b', 'file.ts', 3, 5, 'YY'),
      edit('agent-a', 'file.ts', 0, 2, 'XX'),
    ];
    const result = await mergeAstEdits(edits, { 'file.ts': original });
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    expect(success.merged['file.ts']).toBe('XXCYYF');
  });

  // ---------------------------------------------------------------------------
  // AM-2  Two overlapping byte-identical edits (idempotent dedup)
  // ---------------------------------------------------------------------------

  it('AM-2: two overlapping byte-identical edits → single edit applied (idempotent dedup)', async () => {
    // Both agents want to rename "foo" (0..3) to "bar".
    const original = 'foo()';
    const edits: AstEdit[] = [
      edit('agent-a', 'file.ts', 0, 3, 'bar'),
      edit('agent-b', 'file.ts', 0, 3, 'bar'),
    ];
    const result = await mergeAstEdits(edits, { 'file.ts': original });
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    expect(success.merged['file.ts']).toBe('bar()');
  });

  it('AM-2: overlapping (not identical range) but identical replacement → dedup', async () => {
    // Edit A: 0..5 → "bar"
    // Edit B: 1..5 → "bar"  (overlaps with A, same replacement)
    const original = 'fooXY';
    const edits: AstEdit[] = [
      edit('agent-a', 'file.ts', 0, 5, 'bar'),
      edit('agent-b', 'file.ts', 1, 5, 'bar'),
    ];
    const result = await mergeAstEdits(edits, { 'file.ts': original });
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    // The representative (first seen, index 0) is applied: 0..5 → "bar"
    expect(success.merged['file.ts']).toBe('bar');
  });

  // ---------------------------------------------------------------------------
  // AM-3  Two overlapping non-equivalent edits → conflict
  // ---------------------------------------------------------------------------

  it('AM-3: two overlapping non-equivalent edits → conflict descriptor with both edits', async () => {
    const original = 'function foo() {}';
    const editA = edit('agent-a', 'file.ts', 9, 12, 'bar');
    const editB = edit('agent-b', 'file.ts', 9, 12, 'baz');
    const result = await mergeAstEdits([editA, editB], { 'file.ts': original });
    expect(result.kind).toBe('conflict');
    const conflict = result as MergeResultConflict;
    expect(conflict.conflicts).toHaveLength(1);
    const descriptor = conflict.conflicts[0]!;
    expect(descriptor.filePath).toBe('file.ts');
    expect(descriptor.conflictingEdits).toHaveLength(2);
    expect(descriptor.conflictingEdits).toContainEqual(editA);
    expect(descriptor.conflictingEdits).toContainEqual(editB);
    // Both have exactly the same range → reason is non_equivalent_replacements
    expect(descriptor.reason).toBe('non_equivalent_replacements');
  });

  it('AM-3: overlapping (partial overlap) non-equivalent edits → conflict with overlapping_ranges reason', async () => {
    // Edit A: 0..6 → "AAAA"
    // Edit B: 3..9 → "BBBB"  ← overlaps with A (3 < 6 && 0 < 9)
    const original = '0123456789';
    const editA = edit('agent-a', 'file.ts', 0, 6, 'AAAA');
    const editB = edit('agent-b', 'file.ts', 3, 9, 'BBBB');
    const result = await mergeAstEdits([editA, editB], { 'file.ts': original });
    expect(result.kind).toBe('conflict');
    const conflict = result as MergeResultConflict;
    expect(conflict.conflicts).toHaveLength(1);
    const descriptor = conflict.conflicts[0]!;
    expect(descriptor.reason).toBe('overlapping_ranges');
    expect(descriptor.conflictingEdits).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // AM-4  Two edits in different files
  // ---------------------------------------------------------------------------

  it('AM-4: edits in different files → both files in merged map', async () => {
    const edits: AstEdit[] = [
      edit('agent-a', 'a.ts', 0, 3, 'foo'),
      edit('agent-b', 'b.ts', 0, 3, 'bar'),
    ];
    const original = { 'a.ts': 'XXX', 'b.ts': 'YYY' };
    const result = await mergeAstEdits(edits, original);
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    expect(Object.keys(success.merged)).toHaveLength(2);
    expect(success.merged['a.ts']).toBe('foo');
    expect(success.merged['b.ts']).toBe('bar');
  });

  // ---------------------------------------------------------------------------
  // AM-6  equivalenceCheck injection
  // ---------------------------------------------------------------------------

  it('AM-6: injected equivalenceCheck returning true → overlapping non-identical replacements merge cleanly', async () => {
    // agent-a wants "bar", agent-b wants "baz" — semantically equiv by injection.
    const original = 'foo()';
    const editA = edit('agent-a', 'file.ts', 0, 3, 'bar');
    const editB = edit('agent-b', 'file.ts', 0, 3, 'baz');
    const alwaysEquivalent = async (_a: string, _b: string) => true;
    const result = await mergeAstEdits(
      [editA, editB],
      { 'file.ts': original },
      { equivalenceCheck: alwaysEquivalent },
    );
    expect(result.kind).toBe('success');
    const success = result as MergeResultSuccess;
    // First-seen (editA) wins as representative.
    expect(success.merged['file.ts']).toBe('bar()');
  });

  it('AM-6: injected equivalenceCheck returning false → conflict even for identical replacements', async () => {
    // Paranoid check: equivalenceCheck overrides byte-equality.
    const original = 'foo()';
    const editA = edit('agent-a', 'file.ts', 0, 3, 'bar');
    const editB = edit('agent-b', 'file.ts', 0, 3, 'bar');
    const neverEquivalent = async (_a: string, _b: string) => false;
    const result = await mergeAstEdits(
      [editA, editB],
      { 'file.ts': original },
      { equivalenceCheck: neverEquivalent },
    );
    expect(result.kind).toBe('conflict');
  });

  // ---------------------------------------------------------------------------
  // AM-8  H7 Determinism
  // ---------------------------------------------------------------------------

  it('AM-8: same input in same order → byte-identical merged output on repeated calls', async () => {
    const original = { 'file.ts': 'Hello World Goodbye' };
    const edits: AstEdit[] = [
      edit('agent-a', 'file.ts', 0, 5, 'Hi'),
      edit('agent-b', 'file.ts', 6, 11, 'Earth'),
      edit('agent-c', 'file.ts', 12, 19, 'See ya'),
    ];
    const r1 = await mergeAstEdits(edits, original);
    const r2 = await mergeAstEdits(edits, original);
    expect(r1.kind).toBe('success');
    expect(r2.kind).toBe('success');
    const m1 = (r1 as MergeResultSuccess).merged['file.ts'];
    const m2 = (r2 as MergeResultSuccess).merged['file.ts'];
    expect(m1).toBe(m2);
    expect(m1).toBe('Hi Earth See ya');
  });

  // ---------------------------------------------------------------------------
  // Edge cases
  // ---------------------------------------------------------------------------

  it('single edit in a file → applied correctly', async () => {
    const result = await mergeAstEdits(
      [edit('agent-a', 'x.ts', 3, 6, 'REPLACED')],
      { 'x.ts': 'aaa___bbb' },
    );
    expect(result.kind).toBe('success');
    expect((result as MergeResultSuccess).merged['x.ts']).toBe('aaaREPLACEDbbb');
  });

  it('edit on file absent from originalContent → treats original as empty string', async () => {
    const result = await mergeAstEdits(
      [edit('agent-a', 'new.ts', 0, 0, 'export const x = 1;\n')],
      {},
    );
    expect(result.kind).toBe('success');
    expect((result as MergeResultSuccess).merged['new.ts']).toBe('export const x = 1;\n');
  });

  it('three overlapping edits all identical → idempotent dedup', async () => {
    const original = 'foo';
    const edits: AstEdit[] = [
      edit('agent-a', 'f.ts', 0, 3, 'bar'),
      edit('agent-b', 'f.ts', 0, 3, 'bar'),
      edit('agent-c', 'f.ts', 0, 3, 'bar'),
    ];
    const result = await mergeAstEdits(edits, { 'f.ts': original });
    expect(result.kind).toBe('success');
    expect((result as MergeResultSuccess).merged['f.ts']).toBe('bar');
  });

  it('one clean file + one conflicting file → conflict result (not partial success)', async () => {
    const original = { 'clean.ts': 'Hello', 'conflict.ts': 'World' };
    const edits: AstEdit[] = [
      edit('agent-a', 'clean.ts', 0, 5, 'Hi'),
      edit('agent-a', 'conflict.ts', 0, 5, 'Earth'),
      edit('agent-b', 'conflict.ts', 0, 5, 'Globe'),
    ];
    const result = await mergeAstEdits(edits, original);
    // Entire result is conflict even though clean.ts would have merged.
    expect(result.kind).toBe('conflict');
    const conflict = result as MergeResultConflict;
    expect(conflict.conflicts.every((c) => c.filePath === 'conflict.ts')).toBe(true);
  });

  it('adjacent (non-overlapping) edits: A.end === B.start → treated as non-overlapping', async () => {
    // "AABBCC"
    //  01234 5
    // Edit A: 0..2 → "xx"
    // Edit B: 2..4 → "yy"  (adjacent, not overlapping)
    const original = 'AABBCC';
    const edits: AstEdit[] = [
      edit('agent-a', 'f.ts', 0, 2, 'xx'),
      edit('agent-b', 'f.ts', 2, 4, 'yy'),
    ];
    const result = await mergeAstEdits(edits, { 'f.ts': original });
    expect(result.kind).toBe('success');
    expect((result as MergeResultSuccess).merged['f.ts']).toBe('xxyyCC');
  });
});
