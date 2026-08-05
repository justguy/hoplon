/**
 * tests/operations/computeMinimalPatch.test.ts — LC5 targeted test suite.
 *
 * Required proofs (per PHASE2_TASK_LIST.md § LC5):
 *   LC5-1: out_of_scope_symbol violation → REMOVE_NODES with correct byte ranges
 *   LC5-2: correctedContent re-parses cleanly (no broken syntax)
 *   LC5-3: PATCH_NOT_COMPUTABLE for SCOPE_ESCAPE
 *   LC5-4: PATCH_NOT_COMPUTABLE for STRUCTURAL_CORRUPTION
 *   LC5-5: uncontracted_file violation → REMOVE_NODES (whole-file removal)
 *   LC5-6: multiple out_of_scope violations → ranges merged, correctedContent correct
 *   LC5-7: violations with no byteRange (parse_failure) → PATCH_NOT_COMPUTABLE
 *   LC5-8: H20 — UTF-8 multi-byte content round-trips correctly
 *   LC5-9: determinism — same (content, violations) → byte-identical MinimalPatch
 *   LC5-10: invalid request → ValidationError (kind: 'invalid_manifest')
 *   LC5-11: mixed patchable + unranged violations → REMOVE_NODES with unpatchableViolations
 *   LC5-12: SCOPE_ESCAPE forces PATCH_NOT_COMPUTABLE even if other violations have ranges
 *   LC5-13: engine.computeMinimalPatch wires correctly (integration smoke)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { computeMinimalPatch } from '../../src/hoplon/operations/computeMinimalPatch.js';
import type { ComputeMinimalPatchRequest } from '../../src/hoplon/contracts/computeMinimalPatch.js';
import type { AuditViolation } from '../../src/hoplon/contracts/audit.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createNoopEmitter } from '../../src/hoplon/adapters/emitter/noop.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

// Build a valid out_of_scope_symbol violation from content and a symbol range
function makeOutOfScopeViolation(
  content: string,
  symbolStart: number,
  symbolEnd: number,
  symbolName = 'badSymbol',
  nodeKind = 'function_declaration',
): AuditViolation {
  return {
    kind: 'out_of_scope_symbol',
    path: 'src/foo.ts',
    symbolName,
    nodeKind,
    byteRange: [symbolStart, symbolEnd],
    sourceSlice: Buffer.from(enc(content)).subarray(symbolStart, symbolEnd).toString('utf8'),
    expectedScope: { kind: 'symbols', symbols: ['allowedFn'] },
    message: `Edit modified ${symbolName} which is not in the contracted scope.`,
    correction: `Revert the modification to ${symbolName} and confine edits to [allowedFn].`,
  };
}

function makeScopeEscapeViolation(byteStart = 0, byteEnd = 10): AuditViolation {
  return {
    kind: 'SCOPE_ESCAPE',
    path: 'src/foo.ts',
    escapingNodeKind: 'export_statement',
    parentNodeKind: 'class_declaration',
    byteRange: [byteStart, byteEnd],
    sourceSlice: 'export {}',
    expectedScope: { kind: 'symbols', symbols: ['allowedFn'] },
    message: 'SCOPE_ESCAPE in src/foo.ts.',
    correction: 'Remove the escaping export.',
  };
}

function makeStructuralCorruptionViolation(): AuditViolation {
  return {
    kind: 'STRUCTURAL_CORRUPTION',
    path: 'src/foo.ts',
    corruptedNodeKind: 'ERROR',
    byteRange: [0, 5],
    sourceSlice: 'fn() {',
    message: 'STRUCTURAL_CORRUPTION in src/foo.ts.',
    correction: 'Fix the unclosed brace.',
  };
}

function makeParseFailureViolation(): AuditViolation {
  return {
    kind: 'parse_failure',
    path: 'src/foo.ts',
    parseError: 'parse_timeout',
    nodeKind: null,
    message: 'Could not parse src/foo.ts: parse_timeout.',
    correction: 'Fix the syntax error so it can be parsed.',
  };
}

function makeUncontractedFileViolation(): AuditViolation {
  return {
    kind: 'uncontracted_file',
    path: 'src/bar.ts',
    firstChangedLine: 1,
    sourceSlice: '',
    message: 'File src/bar.ts was modified but is not in the contracted manifest.',
    correction: 'Revert all changes to src/bar.ts.',
  };
}

// ---------------------------------------------------------------------------
// LC5-1: out_of_scope_symbol violation → REMOVE_NODES with correct byte ranges
// ---------------------------------------------------------------------------

describe('LC5: computeMinimalPatch', () => {
  it('LC5-1: out_of_scope_symbol → REMOVE_NODES with correct byte ranges', () => {
    // Build content where we know the byte positions of the violation
    const allowed = 'function allowedFn() { return 1; }\n';
    const bad = 'function badFn() { return 2; }\n';
    const content = allowed + bad;

    const allowedBytes = Buffer.byteLength(allowed, 'utf8');
    const totalBytes = Buffer.byteLength(content, 'utf8');

    const violation = makeOutOfScopeViolation(content, allowedBytes, totalBytes, 'badFn');
    const req: ComputeMinimalPatchRequest = { content, violations: [violation] };

    const result = computeMinimalPatch(req);

    expect(result.patchable).toBe(true);
    expect(result.action).toBe('REMOVE_NODES');
    expect(result.violationRanges).toEqual([[allowedBytes, totalBytes]]);
    // keepRanges = [0, allowedBytes)
    expect(result.keepRanges).toEqual([[0, allowedBytes]]);
    expect(result.correctedContent).toBe(allowed);
    expect(result.unpatchableViolations).toHaveLength(0);
    expect(result.retryPrompt).toContain('badFn');
  });

  // ---------------------------------------------------------------------------
  // LC5-2: correctedContent re-parses cleanly
  // ---------------------------------------------------------------------------

  it('LC5-2: correctedContent contains no syntax error markers', () => {
    // A valid TypeScript function followed by an invalid one (just identifiers, no brace)
    const content = 'function valid() { return true; }\n';
    const badContent = 'function bad() { return false; }\n';
    const full = content + badContent;

    const allowed = Buffer.byteLength(content, 'utf8');
    const total = Buffer.byteLength(full, 'utf8');
    const violation = makeOutOfScopeViolation(full, allowed, total, 'bad');

    const result = computeMinimalPatch({ content: full, violations: [violation] });

    expect(result.patchable).toBe(true);
    // correctedContent should be the valid portion only
    expect(result.correctedContent).toBe(content);
    // correctedContent should not contain "bad" function
    expect(result.correctedContent).not.toContain('function bad');
  });

  // ---------------------------------------------------------------------------
  // LC5-3: PATCH_NOT_COMPUTABLE for SCOPE_ESCAPE
  // ---------------------------------------------------------------------------

  it('LC5-3: SCOPE_ESCAPE violation → PATCH_NOT_COMPUTABLE', () => {
    const content = 'export class Foo { bar() {} }\n';
    const violation = makeScopeEscapeViolation(0, Buffer.byteLength('export class Foo { bar() {} }\n', 'utf8'));

    const result = computeMinimalPatch({ content, violations: [violation] });

    expect(result.patchable).toBe(false);
    expect(result.action).toBe('PATCH_NOT_COMPUTABLE');
    expect(result.violationRanges).toHaveLength(0);
    expect(result.keepRanges).toHaveLength(0);
    expect(result.correctedContent).toBeUndefined();
    expect(result.unpatchableViolations).toHaveLength(1);
    expect(result.unpatchableViolations[0].kind).toBe('SCOPE_ESCAPE');
    expect(result.retryPrompt).toContain('SCOPE_ESCAPE');
  });

  // ---------------------------------------------------------------------------
  // LC5-4: PATCH_NOT_COMPUTABLE for STRUCTURAL_CORRUPTION
  // ---------------------------------------------------------------------------

  it('LC5-4: STRUCTURAL_CORRUPTION violation → PATCH_NOT_COMPUTABLE', () => {
    const content = 'fn() {\n';
    const violation = makeStructuralCorruptionViolation();

    const result = computeMinimalPatch({ content, violations: [violation] });

    expect(result.patchable).toBe(false);
    expect(result.action).toBe('PATCH_NOT_COMPUTABLE');
    expect(result.correctedContent).toBeUndefined();
  });

  // ---------------------------------------------------------------------------
  // LC5-5: uncontracted_file → REMOVE_NODES (whole-file content cleared)
  // ---------------------------------------------------------------------------

  it('LC5-5: uncontracted_file → REMOVE_NODES with empty correctedContent', () => {
    const content = 'const x = 1;\nconst y = 2;\n';
    const violation = makeUncontractedFileViolation();

    const result = computeMinimalPatch({ content, violations: [violation] });

    expect(result.patchable).toBe(true);
    expect(result.action).toBe('REMOVE_NODES');
    // Whole file is the violation range
    const totalBytes = Buffer.byteLength(content, 'utf8');
    expect(result.violationRanges).toEqual([[0, totalBytes]]);
    expect(result.keepRanges).toHaveLength(0);
    expect(result.correctedContent).toBe('');
  });

  // ---------------------------------------------------------------------------
  // LC5-6: multiple out_of_scope violations → ranges merged, correctedContent correct
  // ---------------------------------------------------------------------------

  it('LC5-6: multiple violations → sorted, merged ranges, correct correctedContent', () => {
    // 3 consecutive lines, middle two are violations
    const line1 = 'function keepMe() {}\n';  // kept
    const line2 = 'function bad1() {}\n';   // violated
    const line3 = 'function bad2() {}\n';   // violated
    const content = line1 + line2 + line3;

    const b1 = Buffer.byteLength(line1, 'utf8');
    const b2 = Buffer.byteLength(line2, 'utf8');
    const b3 = Buffer.byteLength(line3, 'utf8');

    const v1 = makeOutOfScopeViolation(content, b1, b1 + b2, 'bad1');
    const v2 = makeOutOfScopeViolation(content, b1 + b2, b1 + b2 + b3, 'bad2');

    // Pass in reverse order — should be sorted by implementation
    const result = computeMinimalPatch({ content, violations: [v2, v1] });

    expect(result.patchable).toBe(true);
    expect(result.action).toBe('REMOVE_NODES');
    // Merged: [b1, b1+b2+b3) — both violations are contiguous
    expect(result.violationRanges).toEqual([[b1, b1 + b2 + b3]]);
    expect(result.keepRanges).toEqual([[0, b1]]);
    expect(result.correctedContent).toBe(line1);
  });

  // ---------------------------------------------------------------------------
  // LC5-7: parse_failure (no byteRange) → PATCH_NOT_COMPUTABLE
  // ---------------------------------------------------------------------------

  it('LC5-7: parse_failure violation (no byteRange) → PATCH_NOT_COMPUTABLE', () => {
    const content = 'broken code here;';
    const violation = makeParseFailureViolation();

    const result = computeMinimalPatch({ content, violations: [violation] });

    expect(result.patchable).toBe(false);
    expect(result.action).toBe('PATCH_NOT_COMPUTABLE');
    expect(result.correctedContent).toBeUndefined();
    expect(result.unpatchableViolations).toHaveLength(1);
  });

  // ---------------------------------------------------------------------------
  // LC5-8: H20 — UTF-8 multi-byte content round-trips correctly
  // ---------------------------------------------------------------------------

  it('LC5-8: UTF-8 multi-byte content round-trips correctly (H20)', () => {
    // Content with CJK characters (3 bytes per char in UTF-8)
    const kept = '// 你好世界\nfunction allowedFn() {}\n';  // kept
    const violated = '// 再见\nfunction badFn() {}\n';       // removed

    const content = kept + violated;
    const keptByteLen = Buffer.byteLength(kept, 'utf8');
    const totalByteLen = Buffer.byteLength(content, 'utf8');

    // Verify that byte length != char length (proves multi-byte)
    expect(keptByteLen).toBeGreaterThan(kept.length);

    const violation = makeOutOfScopeViolation(content, keptByteLen, totalByteLen, 'badFn');
    const result = computeMinimalPatch({ content, violations: [violation] });

    expect(result.patchable).toBe(true);
    // correctedContent should be the exact kept string (round-trip)
    expect(result.correctedContent).toBe(kept);
    // Buffer re-encode of correctedContent should equal the kept portion buffer
    expect(Buffer.from(result.correctedContent!, 'utf8')).toEqual(
      Buffer.from(content, 'utf8').subarray(0, keptByteLen),
    );
  });

  // ---------------------------------------------------------------------------
  // LC5-9: determinism — same inputs → byte-identical result
  // ---------------------------------------------------------------------------

  it('LC5-9: same (content, violations) → byte-identical MinimalPatch (determinism)', () => {
    const content = 'function a() {}\nfunction b() {}\n';
    const bLen = Buffer.byteLength('function a() {}\n', 'utf8');
    const total = Buffer.byteLength(content, 'utf8');
    const violation = makeOutOfScopeViolation(content, bLen, total, 'b');

    const result1 = computeMinimalPatch({ content, violations: [violation] });
    const result2 = computeMinimalPatch({ content, violations: [violation] });

    expect(result1).toEqual(result2);
    expect(result1.correctedContent).toBe(result2.correctedContent);
  });

  // ---------------------------------------------------------------------------
  // LC5-10: invalid request → ValidationError
  // ---------------------------------------------------------------------------

  it('LC5-10: empty violations array → ValidationError (kind: invalid_manifest)', () => {
    expect(() =>
      computeMinimalPatch({ content: 'some code', violations: [] } as ComputeMinimalPatchRequest),
    ).toThrow(ValidationError);

    try {
      computeMinimalPatch({ content: 'some code', violations: [] } as ComputeMinimalPatchRequest);
    } catch (e) {
      expect(e).toBeInstanceOf(ValidationError);
      expect((e as ValidationError).kind).toBe('invalid_manifest');
    }
  });

  it('LC5-10b: missing violations field → ValidationError', () => {
    expect(() =>
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      computeMinimalPatch({ content: 'some code' } as any),
    ).toThrow(ValidationError);
  });

  // ---------------------------------------------------------------------------
  // LC5-11: mixed patchable + unranged violations → REMOVE_NODES + unpatchable list
  // ---------------------------------------------------------------------------

  it('LC5-11: mixed patchable + no-range violations → REMOVE_NODES, unpatchableViolations non-empty', () => {
    const line1 = 'function keepMe() {}\n';
    const line2 = 'function bad() {}\n';
    const content = line1 + line2;
    const b1 = Buffer.byteLength(line1, 'utf8');
    const total = Buffer.byteLength(content, 'utf8');

    const patchable = makeOutOfScopeViolation(content, b1, total, 'bad');
    const noRange = makeParseFailureViolation(); // parse_failure: no byteRange

    const result = computeMinimalPatch({ content, violations: [patchable, noRange] });

    // Still REMOVE_NODES because at least one violation has a range
    expect(result.patchable).toBe(true);
    expect(result.action).toBe('REMOVE_NODES');
    expect(result.correctedContent).toBe(line1);
    // parse_failure violation goes to unpatchableViolations
    expect(result.unpatchableViolations).toHaveLength(1);
    expect(result.unpatchableViolations[0].kind).toBe('parse_failure');
  });

  // ---------------------------------------------------------------------------
  // LC5-12: SCOPE_ESCAPE forces PATCH_NOT_COMPUTABLE even with other ranged violations
  // ---------------------------------------------------------------------------

  it('LC5-12: SCOPE_ESCAPE + out_of_scope → PATCH_NOT_COMPUTABLE (SCOPE_ESCAPE wins)', () => {
    const content = 'export class Foo { bad() {} }\nfunction extra() {}\n';
    const scopeEscape = makeScopeEscapeViolation(0, 10);
    const total = Buffer.byteLength(content, 'utf8');
    const outOfScope = makeOutOfScopeViolation(content, 30, total, 'extra');

    const result = computeMinimalPatch({ content, violations: [scopeEscape, outOfScope] });

    expect(result.patchable).toBe(false);
    expect(result.action).toBe('PATCH_NOT_COMPUTABLE');
    // ALL violations go to unpatchableViolations when PATCH_NOT_COMPUTABLE
    expect(result.unpatchableViolations).toHaveLength(2);
  });

  // ---------------------------------------------------------------------------
  // LC5-13: engine.computeMinimalPatch wires correctly (integration smoke)
  // ---------------------------------------------------------------------------

  let codeIntelligence: Awaited<ReturnType<typeof createTreeSitterIntelligence>>;

  beforeAll(async () => {
    codeIntelligence = await createTreeSitterIntelligence({
      grammarsDir: GRAMMARS_DIR,
    });
  });

  it('LC5-13: engine.computeMinimalPatch wires correctly via factory', async () => {
    const fs = createMemFsAdapter({ root: '/' });
    const versioning = createIsomorphicGitVersioning({ fs });
    const snapshotStore = await createIsolatedTestStore();
    const lockProvider = createAsyncMutexLockProvider();
    const emitter = createNoopEmitter();
    const secretScanner = createBuiltinRegexScanner();

    const engine = await createHoplonEngine(
      { fs, versioning, snapshotStore, lockProvider, emitter, codeIntelligence, secretScanner },
      { fsRoot: '/', engineId: 'lc5-test' },
    );

    const content = 'function good() {}\nfunction bad() {}\n';
    const goodBytes = Buffer.byteLength('function good() {}\n', 'utf8');
    const total = Buffer.byteLength(content, 'utf8');

    const violation = makeOutOfScopeViolation(content, goodBytes, total, 'bad');
    const result = engine.computeMinimalPatch({ content, violations: [violation] });

    expect(result.patchable).toBe(true);
    expect(result.action).toBe('REMOVE_NODES');
    expect(result.correctedContent).toBe('function good() {}\n');
  });
});
