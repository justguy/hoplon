/**
 * tests/contracts/searchSymbols.test.ts — Zod round-trip + invariant proof.
 */

import { describe, it, expect } from 'vitest';
import {
  SEARCHABLE_SYMBOL_KINDS,
  SearchSymbolsRequestSchema,
  SearchSymbolsResultSchema,
} from '../../src/hoplon/contracts/searchSymbols.js';

describe('SearchSymbolsRequestSchema', () => {
  it('accepts a minimal request and applies maxResults default', () => {
    const parsed = SearchSymbolsRequestSchema.parse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      namePattern: '.*',
    });
    expect(parsed.maxResults).toBe(200);
  });

  it('rejects an empty namePattern', () => {
    const r = SearchSymbolsRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      namePattern: '',
    });
    expect(r.success).toBe(false);
  });

  it('rejects unknown kinds', () => {
    const r = SearchSymbolsRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      namePattern: '.*',
      kinds: ['constant'],
    });
    expect(r.success).toBe(false);
  });

  it('caps maxResults at the hard ceiling', () => {
    const r = SearchSymbolsRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      namePattern: '.*',
      maxResults: 1_000_000,
    });
    expect(r.success).toBe(false);
  });

  it('SEARCHABLE_SYMBOL_KINDS covers the documented kinds', () => {
    expect(SEARCHABLE_SYMBOL_KINDS).toEqual([
      'function',
      'class',
      'interface',
      'type',
      'enum',
      'method',
      'export',
    ]);
  });
});

describe('SearchSymbolsResultSchema', () => {
  it('accepts a well-formed result', () => {
    const r = SearchSymbolsResultSchema.parse({
      matches: [
        {
          path: 'src/a.ts',
          name: 'foo',
          kind: 'function',
          byteRange: [0, 10],
          nodeKind: 'identifier',
        },
      ],
      failures: [],
      filesScanned: 1,
      truncated: false,
    });
    expect(r.matches.length).toBe(1);
  });

  it('rejects negative byteRange entries', () => {
    const r = SearchSymbolsResultSchema.safeParse({
      matches: [
        {
          path: 'src/a.ts',
          name: 'foo',
          kind: 'function',
          byteRange: [-1, 0],
          nodeKind: 'identifier',
        },
      ],
      failures: [],
      filesScanned: 1,
      truncated: false,
    });
    expect(r.success).toBe(false);
  });
});
