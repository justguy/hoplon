/**
 * tests/util/retryDedup.test.ts — ML5 targeted test suite.
 *
 * Proof requirements (from slice spec):
 *
 *   ML5-1  Two renamed-variable versions of the same TypeScript file
 *          → same structural hash → recognized as duplicates.
 *
 *   ML5-2  Two structurally-different versions → different hashes → both
 *          kept as unique.
 *
 *   ML5-3  Multi-file candidate: sort order is path-lexicographic (H7).
 *          Changing insertion order of files in the Record must not change
 *          the composite hash.
 *
 *   ML5-4  Empty candidate list → empty unique, empty duplicates.
 *
 *   ML5-5  Single candidate → one unique, zero duplicates.
 *
 *   ML5-6  computeCandidateHash returns `retry-dedup:sha256:<64-char hex>`.
 *
 *   ML5-7  Same candidate hashed twice → same hash (pure determinism, H7).
 *
 *   ML5-8  First-seen wins: the equivalentTo field points to the attemptId
 *          of the first candidate with that structural hash.
 *
 * Test infrastructure:
 *   - createTreeSitterIntelligence (real WASM grammars)
 *   - parseFn wraps ci.parse; detectLang derived from extension
 *   - No fs adapter, no filesystem calls inside retryDedup
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { computeCandidateHash, dedupRetryAttempts } from '../../src/hoplon/util/retryDedup.js';
import type { RetryCandidate, ParseFn, DetectLangFn } from '../../src/hoplon/util/retryDedup.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { RefinedSyntaxNode } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let ci: CodeIntelligenceAdapter;

beforeAll(async () => {
  ci = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

/** Injected parseFn — no adapter construction inside retryDedup. */
const makeParseFn = (): ParseFn => async (source: string, lang: string): Promise<RefinedSyntaxNode> => {
  const filename = `fixture.${lang}`;
  // CodeIntelligenceAdapter.parse accepts (path, content: Uint8Array | string)
  const tree = await ci.parse(filename, enc(source));
  // tree conforms to RefinedSyntaxTree (superset); rootNode is RefinedSyntaxNode
  return tree.rootNode as RefinedSyntaxNode;
};

/** Injected detectLang — maps extension to language string. */
const detectLang: DetectLangFn = (path: string): string => {
  if (path.endsWith('.tsx')) return 'tsx';
  if (path.endsWith('.ts')) return 'ts';
  return 'js';
};

// ---------------------------------------------------------------------------
// Fixtures — TypeScript source variants
// ---------------------------------------------------------------------------

/**
 * Version A — uses variable names: x, y, result.
 */
const TS_RENAMED_A = `
function compute(x: number, y: number): number {
  const result = x + y;
  return result;
}
`.trim();

/**
 * Version B — same structure, different variable names: a, b, sum.
 * Structural hash MUST match TS_RENAMED_A.
 */
const TS_RENAMED_B = `
function compute(a: number, b: number): number {
  const sum = a + b;
  return sum;
}
`.trim();

/**
 * Structurally different version — adds an extra statement.
 * Structural hash MUST differ from TS_RENAMED_A.
 */
const TS_DIFFERENT = `
function compute(x: number, y: number): number {
  const result = x + y;
  console.log(result);
  return result;
}
`.trim();

// ---------------------------------------------------------------------------
// ML5-6 — computeCandidateHash format
// ---------------------------------------------------------------------------

describe('ML5-6: computeCandidateHash returns retry-dedup:sha256:<hex>', () => {
  it('single-file candidate hash matches expected prefix and length', async () => {
    const parse = makeParseFn();
    const candidate: RetryCandidate = {
      attemptId: 'attempt-1',
      files: { 'src/foo.ts': TS_RENAMED_A },
    };

    const hash = await computeCandidateHash(candidate, parse, detectLang);
    expect(hash).toMatch(/^retry-dedup:sha256:[0-9a-f]{64}$/);
  });

  it('empty-files candidate returns a stable hash with correct format', async () => {
    const parse = makeParseFn();
    const candidate: RetryCandidate = {
      attemptId: 'attempt-empty',
      files: {},
    };

    const hash = await computeCandidateHash(candidate, parse, detectLang);
    expect(hash).toMatch(/^retry-dedup:sha256:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// ML5-7 — pure determinism
// ---------------------------------------------------------------------------

describe('ML5-7: same candidate hashed twice → same hash (H7 determinism)', () => {
  it('two calls with identical input return the same composite hash', async () => {
    const parse = makeParseFn();
    const candidate: RetryCandidate = {
      attemptId: 'attempt-det',
      files: { 'src/bar.ts': TS_RENAMED_A },
    };

    const h1 = await computeCandidateHash(candidate, parse, detectLang);
    const h2 = await computeCandidateHash(candidate, parse, detectLang);
    expect(h1).toBe(h2);
  });
});

// ---------------------------------------------------------------------------
// ML5-1 — renamed variables → duplicates
// ---------------------------------------------------------------------------

describe('ML5-1: renamed-variable TS files → same structural hash → duplicate', () => {
  it('candidateA (x,y,result) and candidateB (a,b,sum) produce the same composite hash', async () => {
    const parse = makeParseFn();

    const hashA = await computeCandidateHash(
      { attemptId: 'a1', files: { 'src/compute.ts': TS_RENAMED_A } },
      parse,
      detectLang,
    );
    const hashB = await computeCandidateHash(
      { attemptId: 'a2', files: { 'src/compute.ts': TS_RENAMED_B } },
      parse,
      detectLang,
    );

    expect(hashA).toBe(hashB);
  });

  it('dedupRetryAttempts marks candidateB as duplicate of candidateA', async () => {
    const parse = makeParseFn();

    const candidateA: RetryCandidate = { attemptId: 'a1', files: { 'src/compute.ts': TS_RENAMED_A } };
    const candidateB: RetryCandidate = { attemptId: 'a2', files: { 'src/compute.ts': TS_RENAMED_B } };

    const result = await dedupRetryAttempts([candidateA, candidateB], parse, detectLang);

    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]!.attemptId).toBe('a1');
    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.candidate.attemptId).toBe('a2');
    expect(result.duplicates[0]!.equivalentTo).toBe('a1');
  });
});

// ---------------------------------------------------------------------------
// ML5-2 — structurally different → both unique
// ---------------------------------------------------------------------------

describe('ML5-2: structurally different TS files → different hashes → both unique', () => {
  it('TS_RENAMED_A and TS_DIFFERENT produce different composite hashes', async () => {
    const parse = makeParseFn();

    const hashA = await computeCandidateHash(
      { attemptId: 'a1', files: { 'src/compute.ts': TS_RENAMED_A } },
      parse,
      detectLang,
    );
    const hashD = await computeCandidateHash(
      { attemptId: 'a2', files: { 'src/compute.ts': TS_DIFFERENT } },
      parse,
      detectLang,
    );

    expect(hashA).not.toBe(hashD);
  });

  it('dedupRetryAttempts keeps both as unique', async () => {
    const parse = makeParseFn();

    const candidateA: RetryCandidate = { attemptId: 'a1', files: { 'src/compute.ts': TS_RENAMED_A } };
    const candidateD: RetryCandidate = { attemptId: 'a2', files: { 'src/compute.ts': TS_DIFFERENT } };

    const result = await dedupRetryAttempts([candidateA, candidateD], parse, detectLang);

    expect(result.unique).toHaveLength(2);
    expect(result.duplicates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ML5-3 — multi-file: sort order is path-lexicographic
// ---------------------------------------------------------------------------

describe('ML5-3: multi-file candidate hash is path-lexicographic (H7)', () => {
  it('inserting files in different order into the Record produces the same hash', async () => {
    const parse = makeParseFn();

    // Insert in path order alpha
    const candidateAlpha: RetryCandidate = {
      attemptId: 'mf-alpha',
      files: {
        'src/alpha.ts': TS_RENAMED_A,
        'src/beta.ts': TS_RENAMED_B,
      },
    };

    // Insert in reverse path order — JS object key order differs, but sorted
    // paths must yield the same concatenation
    const candidateBeta: RetryCandidate = {
      attemptId: 'mf-beta',
      files: {
        'src/beta.ts': TS_RENAMED_B,
        'src/alpha.ts': TS_RENAMED_A,
      },
    };

    const hashAlpha = await computeCandidateHash(candidateAlpha, parse, detectLang);
    const hashBeta = await computeCandidateHash(candidateBeta, parse, detectLang);

    expect(hashAlpha).toBe(hashBeta);
  });

  it('multi-file candidate with different content produces a different hash than single-file', async () => {
    const parse = makeParseFn();

    const singleFile: RetryCandidate = {
      attemptId: 'sf',
      files: { 'src/alpha.ts': TS_RENAMED_A },
    };

    const multiFile: RetryCandidate = {
      attemptId: 'mf',
      files: {
        'src/alpha.ts': TS_RENAMED_A,
        'src/beta.ts': TS_RENAMED_B,
      },
    };

    const hashSingle = await computeCandidateHash(singleFile, parse, detectLang);
    const hashMulti = await computeCandidateHash(multiFile, parse, detectLang);

    // Adding a second file changes the concatenation → different hash
    expect(hashSingle).not.toBe(hashMulti);
  });
});

// ---------------------------------------------------------------------------
// ML5-4 — empty candidate list
// ---------------------------------------------------------------------------

describe('ML5-4: empty candidate list → empty result', () => {
  it('returns empty unique and empty duplicates arrays', async () => {
    const parse = makeParseFn();
    const result = await dedupRetryAttempts([], parse, detectLang);

    expect(result.unique).toHaveLength(0);
    expect(result.duplicates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ML5-5 — single candidate
// ---------------------------------------------------------------------------

describe('ML5-5: single candidate → one unique, zero duplicates', () => {
  it('one candidate is always unique', async () => {
    const parse = makeParseFn();

    const only: RetryCandidate = {
      attemptId: 'solo',
      files: { 'src/solo.ts': TS_RENAMED_A },
    };

    const result = await dedupRetryAttempts([only], parse, detectLang);

    expect(result.unique).toHaveLength(1);
    expect(result.unique[0]!.attemptId).toBe('solo');
    expect(result.duplicates).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// ML5-8 — first-seen wins
// ---------------------------------------------------------------------------

describe('ML5-8: first-seen wins — equivalentTo points to the first matching attemptId', () => {
  it('third candidate (same structure as first) maps equivalentTo first, not second', async () => {
    const parse = makeParseFn();

    // a1 and a3 are structurally equivalent; a2 is different
    const a1: RetryCandidate = { attemptId: 'a1', files: { 'src/c.ts': TS_RENAMED_A } };
    const a2: RetryCandidate = { attemptId: 'a2', files: { 'src/c.ts': TS_DIFFERENT } };
    const a3: RetryCandidate = { attemptId: 'a3', files: { 'src/c.ts': TS_RENAMED_B } };

    const result = await dedupRetryAttempts([a1, a2, a3], parse, detectLang);

    expect(result.unique).toHaveLength(2);
    expect(result.unique.map((c) => c.attemptId)).toEqual(['a1', 'a2']);

    expect(result.duplicates).toHaveLength(1);
    expect(result.duplicates[0]!.candidate.attemptId).toBe('a3');
    expect(result.duplicates[0]!.equivalentTo).toBe('a1');
  });
});
