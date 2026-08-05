/**
 * tests/operations/compressRetryContext.test.ts — LC9 targeted test suite.
 *
 * Required tests per PHASE2_TASK_LIST.md § LC9 and plan § Slice LC9:
 *
 *   LC9-1: 3 attempts with shifting violations → correct categorization
 *   LC9-2: empty attempts → empty result
 *   LC9-3: identical attempts → empty delta with all-persistent violations
 *
 * Additional edge-case tests:
 *   LC9-4: single attempt → all violations are "new"
 *   LC9-5: engine facade wires compressRetryContext as synchronous method
 *   LC9-6: violations with identical kind+path+symbolName correctly deduplicated
 *
 * Uses:
 *   - compressRetryContext() direct import (pure function — no adapters needed)
 *   - createHoplonEngine() for facade wiring test (LC9-5)
 *
 * No filesystem, no git, no WASM for the pure function tests.
 * LC9-5 uses full engine construction with in-memory adapters.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { compressRetryContext } from '../../src/hoplon/operations/compressRetryContext.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createBuiltinRegexScanner } from '../../src/hoplon/adapters/secretScanner/builtin.js';
import type { PriorAttempt } from '../../src/hoplon/contracts/retryContext.js';
import type { AuditViolation } from '../../src/hoplon/contracts/audit.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

// ---------------------------------------------------------------------------
// Violation fixtures
// ---------------------------------------------------------------------------

function makeOutOfScopeSymbol(path: string, symbolName: string): AuditViolation {
  return {
    kind: 'out_of_scope_symbol',
    path,
    symbolName,
    nodeKind: 'function_declaration',
    byteRange: [0, 100],
    sourceSlice: `function ${symbolName}() {}`,
    truncated: false,
    expectedScope: { level: 'symbol', path, name: 'allowed', kind: 'function' },
    message: `Symbol '${symbolName}' is out of scope.`,
    correction: `Remove ${symbolName} from ${path}.`,
  };
}

function makeUncontractedFile(path: string): AuditViolation {
  return {
    kind: 'uncontracted_file',
    path,
    firstChangedLine: 1,
    sourceSlice: '',
    truncated: false,
    message: `File ${path} is not in the manifest.`,
    correction: `Remove changes to ${path}.`,
  };
}

function makeParseFailure(path: string): AuditViolation {
  return {
    kind: 'parse_failure',
    path,
    parseError: 'Unexpected token',
    nodeKind: null,
    message: `Parse failed at ${path}.`,
    correction: `Fix syntax in ${path}.`,
  };
}

// ---------------------------------------------------------------------------
// LC9-1: 3 attempts with shifting violations → correct categorization
// ---------------------------------------------------------------------------

describe('LC9-1: shifting violations across 3 attempts', () => {
  // attempt 1: A + B
  // attempt 2: A + C (B resolved, C new)
  // attempt 3: A + D (C resolved, D new; A persistent throughout)
  const violationA = makeOutOfScopeSymbol('src/foo.ts', 'badFn');
  const violationB = makeUncontractedFile('src/extra.ts');
  const violationC = makeOutOfScopeSymbol('src/bar.ts', 'wrongHelper');
  const violationD = makeParseFailure('src/baz.ts');

  const attempt1: PriorAttempt = {
    attemptNumber: 1,
    proposedContent: '// attempt 1',
    violations: [violationA, violationB],
  };
  const attempt2: PriorAttempt = {
    attemptNumber: 2,
    proposedContent: '// attempt 2',
    violations: [violationA, violationC],
  };
  const attempt3: PriorAttempt = {
    attemptNumber: 3,
    proposedContent: '// attempt 3',
    violations: [violationA, violationD],
  };

  const result = compressRetryContext([attempt1, attempt2, attempt3]);

  it('reports correct attemptCount', () => {
    expect(result.attemptCount).toBe(3);
  });

  it('violationA is persistent (present in all 3 attempts)', () => {
    expect(result.persistentViolations).toHaveLength(1);
    expect(result.persistentViolations[0]!.kind).toBe('out_of_scope_symbol');
    const v = result.persistentViolations[0] as Extract<AuditViolation, { kind: 'out_of_scope_symbol' }>;
    expect(v.symbolName).toBe('badFn');
  });

  it('violationB and violationC are resolved (absent from latest attempt)', () => {
    const resolvedKinds = result.resolvedViolations.map((v) => v.kind);
    // B was in attempt 1 and 2, gone in attempt 3
    // C was in attempt 2, gone in attempt 3
    // Both should appear in resolved
    expect(resolvedKinds).toContain('uncontracted_file');
    expect(resolvedKinds).toContain('out_of_scope_symbol');
    // the resolved out_of_scope_symbol should be wrongHelper, not badFn
    const resolvedOos = result.resolvedViolations.find(
      (v): v is Extract<AuditViolation, { kind: 'out_of_scope_symbol' }> =>
        v.kind === 'out_of_scope_symbol',
    );
    expect(resolvedOos?.symbolName).toBe('wrongHelper');
  });

  it('violationD is new (only in latest attempt)', () => {
    expect(result.newViolations).toHaveLength(1);
    expect(result.newViolations[0]!.kind).toBe('parse_failure');
  });

  it('structuralDelta mentions all three categories', () => {
    expect(result.structuralDelta).toContain('Persistent');
    expect(result.structuralDelta).toContain('Resolved');
    expect(result.structuralDelta).toContain('Newly introduced');
  });

  it('retryDirective is a non-empty string', () => {
    expect(typeof result.retryDirective).toBe('string');
    expect(result.retryDirective.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LC9-2: empty attempts → empty result
// ---------------------------------------------------------------------------

describe('LC9-2: empty attempts array → empty result', () => {
  const result = compressRetryContext([]);

  it('returns attemptCount 0', () => {
    expect(result.attemptCount).toBe(0);
  });

  it('all violation arrays are empty', () => {
    expect(result.persistentViolations).toHaveLength(0);
    expect(result.resolvedViolations).toHaveLength(0);
    expect(result.newViolations).toHaveLength(0);
  });

  it('structuralDelta is a non-empty string', () => {
    expect(typeof result.structuralDelta).toBe('string');
    expect(result.structuralDelta.length).toBeGreaterThan(0);
  });

  it('retryDirective is a non-empty string', () => {
    expect(typeof result.retryDirective).toBe('string');
    expect(result.retryDirective.length).toBeGreaterThan(0);
  });
});

// ---------------------------------------------------------------------------
// LC9-3: identical attempts → all persistent, empty delta
// ---------------------------------------------------------------------------

describe('LC9-3: identical attempts → all-persistent violations, empty resolved/new', () => {
  const violationA = makeOutOfScopeSymbol('src/foo.ts', 'badFn');
  const violationB = makeUncontractedFile('src/extra.ts');

  const attempt1: PriorAttempt = {
    attemptNumber: 1,
    proposedContent: '// same content',
    violations: [violationA, violationB],
  };
  const attempt2: PriorAttempt = {
    attemptNumber: 2,
    proposedContent: '// same content',
    violations: [violationA, violationB],
  };
  const attempt3: PriorAttempt = {
    attemptNumber: 3,
    proposedContent: '// same content',
    violations: [violationA, violationB],
  };

  const result = compressRetryContext([attempt1, attempt2, attempt3]);

  it('all violations are persistent (2 total)', () => {
    expect(result.persistentViolations).toHaveLength(2);
  });

  it('no resolved violations', () => {
    expect(result.resolvedViolations).toHaveLength(0);
  });

  it('no new violations', () => {
    expect(result.newViolations).toHaveLength(0);
  });

  it('structuralDelta does not mention Resolved or Newly introduced', () => {
    expect(result.structuralDelta).not.toContain('Resolved');
    expect(result.structuralDelta).not.toContain('Newly introduced');
  });
});

// ---------------------------------------------------------------------------
// LC9-4: single attempt → all violations categorized as "new"
// ---------------------------------------------------------------------------

describe('LC9-4: single attempt → all violations are new', () => {
  const v1 = makeOutOfScopeSymbol('src/foo.ts', 'badFn');
  const v2 = makeUncontractedFile('src/extra.ts');

  const attempt: PriorAttempt = {
    attemptNumber: 1,
    proposedContent: '// first attempt',
    violations: [v1, v2],
  };

  const result = compressRetryContext([attempt]);

  it('returns attemptCount 1', () => {
    expect(result.attemptCount).toBe(1);
  });

  it('persistentViolations is empty (no history to compare)', () => {
    expect(result.persistentViolations).toHaveLength(0);
  });

  it('resolvedViolations is empty', () => {
    expect(result.resolvedViolations).toHaveLength(0);
  });

  it('all 2 violations are new', () => {
    expect(result.newViolations).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// LC9-5: engine facade wires compressRetryContext as synchronous method
// ---------------------------------------------------------------------------

describe('LC9-5: engine facade — compressRetryContext is synchronous', () => {
  let engineInstance: Awaited<ReturnType<typeof createHoplonEngine>>;

  beforeAll(async () => {
    const fs = createMemFsAdapter({ root: '/' });
    const versioning = createIsomorphicGitVersioning({ fs });
    const snapshotStore = await createIsolatedTestStore();
    const lockProvider = createAsyncMutexLockProvider();
    const emitter = createMemoryEmitter();
    const codeIntelligence = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
    const secretScanner = createBuiltinRegexScanner();

    engineInstance = await createHoplonEngine(
      { fs, versioning, snapshotStore, lockProvider, emitter, codeIntelligence, secretScanner },
      { fsRoot: '/', engineId: 'lc9-test' },
    );
  });

  it('engine.compressRetryContext exists and is a function', () => {
    expect(typeof engineInstance.compressRetryContext).toBe('function');
  });

  it('engine.compressRetryContext returns synchronously (not a Promise)', () => {
    const result = engineInstance.compressRetryContext([]);
    // Must NOT be a Promise — the result should be the plain object
    expect(result).not.toBeInstanceOf(Promise);
    expect(result.attemptCount).toBe(0);
  });

  it('engine.compressRetryContext returns correct categorization on 2-attempt input', () => {
    const v1 = makeOutOfScopeSymbol('src/a.ts', 'fnX');
    const v2 = makeOutOfScopeSymbol('src/b.ts', 'fnY');

    const attempts: PriorAttempt[] = [
      { attemptNumber: 1, proposedContent: '// a1', violations: [v1, v2] },
      { attemptNumber: 2, proposedContent: '// a2', violations: [v1] }, // v2 resolved
    ];

    const result = engineInstance.compressRetryContext(attempts);

    expect(result.persistentViolations).toHaveLength(1);
    expect(result.resolvedViolations).toHaveLength(1);
    expect(result.newViolations).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// LC9-6: symbolName as secondary key prevents false deduplication
// ---------------------------------------------------------------------------

describe('LC9-6: violations with same kind+path but different symbolName are distinct', () => {
  // Two violations: same kind, same path, different symbolName
  const v1 = makeOutOfScopeSymbol('src/foo.ts', 'fnA');
  const v2 = makeOutOfScopeSymbol('src/foo.ts', 'fnB');

  const attempt1: PriorAttempt = {
    attemptNumber: 1,
    proposedContent: '// a1',
    violations: [v1],
  };
  const attempt2: PriorAttempt = {
    attemptNumber: 2,
    proposedContent: '// a2',
    violations: [v2], // different symbol — v1 resolved, v2 new
  };

  const result = compressRetryContext([attempt1, attempt2]);

  it('v1 (fnA) is resolved — gone from latest', () => {
    const resolved = result.resolvedViolations as Array<Extract<AuditViolation, { kind: 'out_of_scope_symbol' }>>;
    const resolvedNames = resolved.map((v) => v.symbolName);
    expect(resolvedNames).toContain('fnA');
  });

  it('v2 (fnB) is new — only in latest', () => {
    const newV = result.newViolations as Array<Extract<AuditViolation, { kind: 'out_of_scope_symbol' }>>;
    const newNames = newV.map((v) => v.symbolName);
    expect(newNames).toContain('fnB');
  });

  it('no persistent violations (different symbols each time)', () => {
    expect(result.persistentViolations).toHaveLength(0);
  });
});
