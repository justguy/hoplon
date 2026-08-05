/**
 * tests/session/unifiedDiff.test.ts — deterministic unified-diff proofs (t-072).
 *
 * Exercises the pure string helper used by the review payload composer. No
 * tree-sitter, no adapters.
 */

import { describe, it, expect } from 'vitest';

import { renderUnifiedDiff } from '../../src/hoplon/session/unifiedDiff.js';

describe('renderUnifiedDiff (t-072)', () => {
  it('returns an empty body when the inputs match exactly', () => {
    const out = renderUnifiedDiff('export const x = 1;\n', 'export const x = 1;\n', {
      aLabel: 'a.ts',
      bLabel: 'a.ts',
      includeHeader: false,
    });
    expect(out).toBe('');
  });

  it('emits standard headers + one hunk when a single line differs', () => {
    const before = ['export const x = 1;', 'export const y = 2;', ''].join('\n');
    const after = ['export const x = 1;', 'export const y = 3;', ''].join('\n');
    const out = renderUnifiedDiff(before, after, { aLabel: 'a.ts', bLabel: 'a.ts' });
    expect(out).toContain('--- a/a.ts');
    expect(out).toContain('+++ b/a.ts');
    expect(out).toMatch(/@@ -\d+,\d+ \+\d+,\d+ @@/);
    expect(out).toContain('-export const y = 2;');
    expect(out).toContain('+export const y = 3;');
  });

  it('omits the --- / +++ header when includeHeader=false so boundary blocks can nest', () => {
    const before = 'foo\n';
    const after = 'bar\n';
    const out = renderUnifiedDiff(before, after, {
      aLabel: 'x',
      bLabel: 'x',
      includeHeader: false,
    });
    expect(out).not.toContain('--- ');
    expect(out).not.toContain('+++ ');
    expect(out).toContain('-foo');
    expect(out).toContain('+bar');
  });

  it('deterministic — two identical runs produce byte-identical output', () => {
    const before = 'alpha\nbeta\ngamma\n';
    const after = 'alpha\nBETA\ngamma\n';
    const a = renderUnifiedDiff(before, after, { aLabel: 'p', bLabel: 'p' });
    const b = renderUnifiedDiff(before, after, { aLabel: 'p', bLabel: 'p' });
    expect(a).toBe(b);
  });

  it('honors contextLines and includes surrounding context', () => {
    const before = ['one', 'two', 'three', 'four', 'five', 'six'].join('\n');
    const after = ['one', 'two', 'THREE', 'four', 'five', 'six'].join('\n');
    const out = renderUnifiedDiff(before, after, {
      aLabel: 'ctx',
      bLabel: 'ctx',
      contextLines: 1,
    });
    expect(out).toContain(' two');
    expect(out).toContain('-three');
    expect(out).toContain('+THREE');
    expect(out).toContain(' four');
    // contextLines=1 should not pull in "one" / "five"
    expect(out).not.toMatch(/ one\n/);
  });
});
