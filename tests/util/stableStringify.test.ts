/**
 * Tests for stableStringify.
 *
 * Key invariant: reordering object keys yields identical output.
 * Nested objects, arrays, and primitives are all stable.
 */

import { describe, it, expect } from 'vitest';
import { stableStringify } from '../../src/hoplon/util/stableStringify.js';

describe('stableStringify', () => {
  it('produces identical output regardless of key insertion order', () => {
    const a = stableStringify({ z: 1, a: 2, m: 3 });
    const b = stableStringify({ a: 2, m: 3, z: 1 });
    const c = stableStringify({ m: 3, z: 1, a: 2 });
    expect(a).toBe(b);
    expect(b).toBe(c);
  });

  it('sorts keys alphabetically', () => {
    const result = stableStringify({ z: 3, a: 1, m: 2 });
    expect(result).toBe('{"a":1,"m":2,"z":3}');
  });

  it('handles nested objects with reordered keys', () => {
    const a = stableStringify({ outer: { z: 1, a: 2 }, x: 'hello' });
    const b = stableStringify({ x: 'hello', outer: { a: 2, z: 1 } });
    expect(a).toBe(b);
  });

  it('preserves array element order', () => {
    const a = stableStringify({ items: [3, 1, 2] });
    const b = stableStringify({ items: [3, 1, 2] });
    expect(a).toBe(b);
    // Arrays are NOT sorted — order is preserved
    expect(a).toBe('{"items":[3,1,2]}');
  });

  it('handles primitives', () => {
    expect(stableStringify(42)).toBe('42');
    expect(stableStringify('hello')).toBe('"hello"');
    expect(stableStringify(true)).toBe('true');
    expect(stableStringify(null)).toBe('null');
  });

  it('handles empty object', () => {
    expect(stableStringify({})).toBe('{}');
  });

  it('handles empty array', () => {
    expect(stableStringify([])).toBe('[]');
  });

  it('handles deeply nested structure', () => {
    const a = stableStringify({ a: { b: { c: { z: 1, d: 2 } } } });
    const b = stableStringify({ a: { b: { c: { d: 2, z: 1 } } } });
    expect(a).toBe(b);
  });
});
