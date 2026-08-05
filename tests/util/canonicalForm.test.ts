/**
 * tests/util/canonicalForm.test.ts — CF1 targeted test suite.
 *
 * Proof requirements:
 *
 *   CF1-1  Idempotency: serialized output re-serialized equals itself
 *          (stableStringify(JSON.parse(form.serialized)) === form.serialized)
 *
 *   CF1-2  Structural equivalence: two JS files that differ only in variable
 *          names produce the same structural canonical hash.
 *
 *   CF1-3  Signature equivalence: two TS files with identical identifiers and
 *          structure but different whitespace/comments → same signature hash.
 *
 *   CF1-4  Structurally different files → different structural hashes.
 *
 *   CF1-5  Structural mode strips string literals to 'string_literal' placeholder.
 *
 *   CF1-6  Structural mode strips number literals to 'number_literal' placeholder.
 *
 *   CF1-7  Signature mode preserves identifiers.
 *
 *   CF1-8  Signature mode strips comment nodes.
 *
 *   CF1-9  hash has 'sha256:' prefix format.
 *
 *   CF1-10 mode field matches the requested mode on the returned form.
 *
 *   CF1-11 Renamed function names → same structural hash, different signature hash.
 *
 * Test infrastructure:
 *   - createTreeSitterIntelligence (real WASM grammars)
 *   - RefinedSyntaxTree.rootNode passed directly to canonicalForm
 *   - No fs adapter needed (we pass content directly to parse())
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { canonicalForm } from '../../src/hoplon/util/canonicalForm.js';
import type { SerializedCanonicalForm } from '../../src/hoplon/util/canonicalForm.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { RefinedSyntaxTree } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { stableStringify } from '../../src/hoplon/util/stableStringify.js';

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

async function parseJs(src: string): Promise<RefinedSyntaxTree> {
  return ci.parse('fixture.js', enc(src)) as Promise<RefinedSyntaxTree>;
}

async function parseTs(src: string): Promise<RefinedSyntaxTree> {
  return ci.parse('fixture.ts', enc(src)) as Promise<RefinedSyntaxTree>;
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** Two JS functions with identical structure but different variable/param names */
const FIXTURE_STRUCT_A = `
function add(x, y) {
  const result = x + y;
  return result;
}
`.trim();

const FIXTURE_STRUCT_B = `
function multiply(a, b) {
  const product = a * b;
  return product;
}
`.trim();

/** FIXTURE_STRUCT_A with a structurally different body (additional statement) */
const FIXTURE_STRUCT_DIFFERENT = `
function add(x, y) {
  const result = x + y;
  console.log(result);
  return result;
}
`.trim();

/** Two TS files with identical identifiers but different whitespace and comments */
const FIXTURE_SIG_A = `export function formatPrice(value: number): string { return String(value); }`;
const FIXTURE_SIG_B = `
// Format a price value as a string
export function formatPrice(
  value: number,
): string {
  return String(value);
}
`.trim();

/** Same identifier as FIXTURE_SIG_A but renamed function */
const FIXTURE_SIG_RENAMED = `export function formatCurrency(value: number): string { return String(value); }`;

// ---------------------------------------------------------------------------
// CF1-1 — Idempotency
// ---------------------------------------------------------------------------

describe('CF1-1: idempotency — serialized output re-serialized equals itself', () => {
  it('structural mode: stableStringify(JSON.parse(form.serialized)) === form.serialized', async () => {
    const tree = await parseJs(FIXTURE_STRUCT_A);
    const form = canonicalForm(tree.rootNode, 'structural');

    const reparsed = JSON.parse(form.serialized) as unknown;
    const reserialised = stableStringify(reparsed);
    expect(reserialised).toBe(form.serialized);
  });

  it('signature mode: stableStringify(JSON.parse(form.serialized)) === form.serialized', async () => {
    const tree = await parseTs(FIXTURE_SIG_A);
    const form = canonicalForm(tree.rootNode, 'signature');

    const reparsed = JSON.parse(form.serialized) as unknown;
    const reserialised = stableStringify(reparsed);
    expect(reserialised).toBe(form.serialized);
  });

  it('same tree called twice → same hash (pure determinism)', async () => {
    const tree = await parseJs(FIXTURE_STRUCT_A);
    const form1 = canonicalForm(tree.rootNode, 'structural');
    const form2 = canonicalForm(tree.rootNode, 'structural');
    expect(form1.hash).toBe(form2.hash);
    expect(form1.serialized).toBe(form2.serialized);
  });
});

// ---------------------------------------------------------------------------
// CF1-2 — Structural equivalence: renamed vars → same structural hash
// ---------------------------------------------------------------------------

describe('CF1-2: structural equivalence — renamed vars produce same structural hash', () => {
  it('FIXTURE_STRUCT_A and FIXTURE_STRUCT_B produce the same structural hash', async () => {
    const treeA = await parseJs(FIXTURE_STRUCT_A);
    const treeB = await parseJs(FIXTURE_STRUCT_B);

    const formA = canonicalForm(treeA.rootNode, 'structural');
    const formB = canonicalForm(treeB.rootNode, 'structural');

    expect(formA.hash).toBe(formB.hash);
  });

  it('FIXTURE_STRUCT_A and FIXTURE_STRUCT_B produce the same structural serialized form', async () => {
    const treeA = await parseJs(FIXTURE_STRUCT_A);
    const treeB = await parseJs(FIXTURE_STRUCT_B);

    const formA = canonicalForm(treeA.rootNode, 'structural');
    const formB = canonicalForm(treeB.rootNode, 'structural');

    expect(formA.serialized).toBe(formB.serialized);
  });
});

// ---------------------------------------------------------------------------
// CF1-3 — Signature equivalence: same identifiers, different whitespace/comments
// ---------------------------------------------------------------------------

describe('CF1-3: signature equivalence — whitespace/comment variants produce same signature hash', () => {
  it('FIXTURE_SIG_A and FIXTURE_SIG_B produce the same signature hash', async () => {
    const treeA = await parseTs(FIXTURE_SIG_A);
    const treeB = await parseTs(FIXTURE_SIG_B);

    const formA = canonicalForm(treeA.rootNode, 'signature');
    const formB = canonicalForm(treeB.rootNode, 'signature');

    expect(formA.hash).toBe(formB.hash);
  });
});

// ---------------------------------------------------------------------------
// CF1-4 — Structurally different files → different structural hashes
// ---------------------------------------------------------------------------

describe('CF1-4: structurally different files produce different structural hashes', () => {
  it('FIXTURE_STRUCT_A and FIXTURE_STRUCT_DIFFERENT produce different structural hashes', async () => {
    const treeA = await parseJs(FIXTURE_STRUCT_A);
    const treeDiff = await parseJs(FIXTURE_STRUCT_DIFFERENT);

    const formA = canonicalForm(treeA.rootNode, 'structural');
    const formDiff = canonicalForm(treeDiff.rootNode, 'structural');

    expect(formA.hash).not.toBe(formDiff.hash);
  });
});

// ---------------------------------------------------------------------------
// CF1-5 — Structural mode strips string literals
// ---------------------------------------------------------------------------

describe('CF1-5: structural mode collapses string literals to string_literal placeholder', () => {
  it('two functions differing only in string literal content → same structural hash', async () => {
    const src1 = `function greet() { return "hello"; }`;
    const src2 = `function greet() { return "goodbye world something longer"; }`;

    const t1 = await parseJs(src1);
    const t2 = await parseJs(src2);

    const f1 = canonicalForm(t1.rootNode, 'structural');
    const f2 = canonicalForm(t2.rootNode, 'structural');

    expect(f1.hash).toBe(f2.hash);
  });
});

// ---------------------------------------------------------------------------
// CF1-6 — Structural mode strips number literals
// ---------------------------------------------------------------------------

describe('CF1-6: structural mode collapses number literals to number_literal placeholder', () => {
  it('two functions differing only in numeric constant → same structural hash', async () => {
    const src1 = `function limit() { return 42; }`;
    const src2 = `function limit() { return 9999; }`;

    const t1 = await parseJs(src1);
    const t2 = await parseJs(src2);

    const f1 = canonicalForm(t1.rootNode, 'structural');
    const f2 = canonicalForm(t2.rootNode, 'structural');

    expect(f1.hash).toBe(f2.hash);
  });
});

// ---------------------------------------------------------------------------
// CF1-7 — Signature mode preserves identifiers
// ---------------------------------------------------------------------------

describe('CF1-7: signature mode preserves identifier text', () => {
  it('serialized form contains the function name in signature mode', async () => {
    const src = `export function computeHash(input: string): string { return input; }`;
    const tree = await parseTs(src);
    const form = canonicalForm(tree.rootNode, 'signature');

    // The serialized canonical form is JSON; the identifier 'computeHash' must appear
    expect(form.serialized).toContain('computeHash');
  });

  it('serialized form contains the param name in signature mode', async () => {
    const src = `export function transform(myParam: number): number { return myParam; }`;
    const tree = await parseTs(src);
    const form = canonicalForm(tree.rootNode, 'signature');

    expect(form.serialized).toContain('myParam');
  });
});

// ---------------------------------------------------------------------------
// CF1-8 — Signature mode strips comments
// ---------------------------------------------------------------------------

describe('CF1-8: signature mode strips comment nodes', () => {
  it('function with and without JSDoc comment → same signature hash', async () => {
    const withDoc = `
/** Adds two numbers. */
export function add(a: number, b: number): number { return a + b; }
`.trim();
    const withoutDoc = `export function add(a: number, b: number): number { return a + b; }`;

    const tWith = await parseTs(withDoc);
    const tWithout = await parseTs(withoutDoc);

    const fWith = canonicalForm(tWith.rootNode, 'signature');
    const fWithout = canonicalForm(tWithout.rootNode, 'signature');

    expect(fWith.hash).toBe(fWithout.hash);
  });

  it('inline comment not reflected in signature serialized form', async () => {
    const src = `
// This is a comment
function foo() { return 1; }
`.trim();
    const tree = await parseJs(src);
    const form = canonicalForm(tree.rootNode, 'signature');

    expect(form.serialized).not.toContain('This is a comment');
  });
});

// ---------------------------------------------------------------------------
// CF1-9 — hash has sha256: prefix
// ---------------------------------------------------------------------------

describe('CF1-9: hash has sha256: prefix format', () => {
  it('structural mode hash matches /^sha256:[0-9a-f]{64}$/', async () => {
    const tree = await parseJs(FIXTURE_STRUCT_A);
    const form = canonicalForm(tree.rootNode, 'structural');
    expect(form.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });

  it('signature mode hash matches /^sha256:[0-9a-f]{64}$/', async () => {
    const tree = await parseTs(FIXTURE_SIG_A);
    const form = canonicalForm(tree.rootNode, 'signature');
    expect(form.hash).toMatch(/^sha256:[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// CF1-10 — mode field matches requested mode
// ---------------------------------------------------------------------------

describe('CF1-10: mode field on returned form matches requested mode', () => {
  it('structural mode → form.mode === "structural"', async () => {
    const tree = await parseJs(FIXTURE_STRUCT_A);
    const form: SerializedCanonicalForm = canonicalForm(tree.rootNode, 'structural');
    expect(form.mode).toBe('structural');
  });

  it('signature mode → form.mode === "signature"', async () => {
    const tree = await parseTs(FIXTURE_SIG_A);
    const form: SerializedCanonicalForm = canonicalForm(tree.rootNode, 'signature');
    expect(form.mode).toBe('signature');
  });
});

// ---------------------------------------------------------------------------
// CF1-11 — Renamed function: same structural hash, different signature hash
// ---------------------------------------------------------------------------

describe('CF1-11: renamed function name → same structural hash, different signature hash', () => {
  it('FIXTURE_SIG_A and FIXTURE_SIG_RENAMED produce the same structural hash', async () => {
    const tA = await parseTs(FIXTURE_SIG_A);
    const tR = await parseTs(FIXTURE_SIG_RENAMED);

    const fA = canonicalForm(tA.rootNode, 'structural');
    const fR = canonicalForm(tR.rootNode, 'structural');

    expect(fA.hash).toBe(fR.hash);
  });

  it('FIXTURE_SIG_A and FIXTURE_SIG_RENAMED produce different signature hashes', async () => {
    const tA = await parseTs(FIXTURE_SIG_A);
    const tR = await parseTs(FIXTURE_SIG_RENAMED);

    const fA = canonicalForm(tA.rootNode, 'signature');
    const fR = canonicalForm(tR.rootNode, 'signature');

    expect(fA.hash).not.toBe(fR.hash);
  });
});
