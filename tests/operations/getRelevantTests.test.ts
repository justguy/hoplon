/**
 * tests/operations/getRelevantTests.test.ts — LC10 targeted test suite.
 *
 * Proof requirements:
 *  RT-1  Direct import: test file directly importing a modified file → in relevantTests
 *  RT-2  Transitive depth-2 import: test → intermediate → modified → in relevantTests
 *  RT-3  Transitive depth-3 import with maxDepth=2: test → A → B → modified → NOT included
 *  RT-4  Unrelated test with no import path to modified file → NOT in relevantTests
 *  RT-5  Modified file imported by no test → in unusedModifiedFiles
 *  RT-6  Dynamic require() detected → coverageConfidence: 'conservative'
 *  RT-7  No dynamic require → coverageConfidence: 'exact'
 *  RT-8  Empty file set → empty relevantTests + all modified in unusedModifiedFiles
 *  RT-9  H7 determinism: relevantTests and unusedModifiedFiles are sorted
 *  RT-10 Invalid request (empty modifiedFiles) → ValidationError
 *  RT-11 Custom testPatterns and custom maxDepth respected
 *  RT-12 H13: emitted events contain no source content
 *
 * Uses:
 *   - createMemFsAdapter()       — in-memory fs (C2)
 *   - createTreeSitterIntelligence() — real WASM grammars (D3)
 *   - createMemoryEmitter()      — in-memory event store (C5)
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { getRelevantTests } from '../../src/hoplon/operations/getRelevantTests.js';
import type { GetRelevantTestsDeps } from '../../src/hoplon/operations/getRelevantTests.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { GetRelevantTestsRequest } from '../../src/hoplon/contracts/getRelevantTests.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeDeps(): { deps: GetRelevantTestsDeps; fs: ReturnType<typeof createMemFsAdapter>; emitter: ReturnType<typeof createMemoryEmitter> } {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const deps: GetRelevantTestsDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-engine',
    root: '/',
    config: { maxFileBytes: 524288, parseTimeoutMs: 5000 },
  };
  return { deps, fs, emitter };
}

function makeReq(overrides: Partial<GetRelevantTestsRequest> = {}): GetRelevantTestsRequest {
  return {
    projectId: 'proj-rt-test',
    runId: 'run-rt-001',
    correlationId: 'corr-rt-001',
    modifiedFiles: ['src/service.ts'],
    testPatterns: ['.test.', '.spec.'],
    maxDepth: 2,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// RT-1: Direct import — test directly imports modified file
// ---------------------------------------------------------------------------

describe('RT-1: direct import', () => {
  it('test file directly importing a modified file → in relevantTests', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc(`export function doWork() {}`));
    await fs.write('tests/service.test.ts', enc(`import { doWork } from '../src/service.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
    }));

    expect(result.relevantTests).toContain('tests/service.test.ts');
    expect(result.coverageConfidence).toBe('exact');
    expect(result.unusedModifiedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RT-2: Transitive depth-2 import — test → intermediate → modified
// ---------------------------------------------------------------------------

describe('RT-2: transitive depth-2', () => {
  it('transitive import at depth 2 → in relevantTests', async () => {
    const { deps, fs } = makeDeps();

    // modified: src/core.ts
    await fs.write('src/core.ts', enc(`export const CORE = 1;`));
    // intermediate: src/service.ts imports core
    await fs.write('src/service.ts', enc(`import { CORE } from './core.js';\nexport const X = CORE;`));
    // test imports service (depth-1 edge: test→service; depth-2: test→service→core)
    await fs.write('tests/service.test.ts', enc(`import { X } from '../src/service.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/core.ts'],
      maxDepth: 2,
    }));

    expect(result.relevantTests).toContain('tests/service.test.ts');
    expect(result.unusedModifiedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RT-3: Transitive depth-3 with maxDepth=2 → NOT included
// ---------------------------------------------------------------------------

describe('RT-3: depth-3 with maxDepth=2 not included', () => {
  it('transitive import at depth 3 with maxDepth=2 → NOT in relevantTests', async () => {
    const { deps, fs } = makeDeps();

    // chain: test → A → B → modified (depth 3 from test)
    await fs.write('src/deep.ts', enc(`export const DEEP = 1;`));
    await fs.write('src/middle.ts', enc(`import { DEEP } from './deep.js';\nexport const M = DEEP;`));
    await fs.write('src/wrapper.ts', enc(`import { M } from './middle.js';\nexport const W = M;`));
    await fs.write('tests/wrapper.test.ts', enc(`import { W } from '../src/wrapper.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/deep.ts'],
      maxDepth: 2,
    }));

    // At depth 2: test → wrapper → middle. Does NOT reach deep.ts.
    expect(result.relevantTests).not.toContain('tests/wrapper.test.ts');
    expect(result.unusedModifiedFiles).toContain('src/deep.ts');
  });
});

// ---------------------------------------------------------------------------
// RT-4: Unrelated test — no import path to modified file
// ---------------------------------------------------------------------------

describe('RT-4: unrelated test not included', () => {
  it('test with no import path to modified file → NOT in relevantTests', async () => {
    const { deps, fs } = makeDeps();

    await fs.write('src/service.ts', enc(`export const A = 1;`));
    await fs.write('src/unrelated.ts', enc(`export const B = 2;`));
    await fs.write('tests/unrelated.test.ts', enc(`import { B } from '../src/unrelated.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
    }));

    expect(result.relevantTests).not.toContain('tests/unrelated.test.ts');
    expect(result.unusedModifiedFiles).toContain('src/service.ts');
  });
});

// ---------------------------------------------------------------------------
// RT-5: Modified file imported by no test → in unusedModifiedFiles
// ---------------------------------------------------------------------------

describe('RT-5: unused modified file', () => {
  it('modified file imported by no test → in unusedModifiedFiles', async () => {
    const { deps, fs } = makeDeps();

    await fs.write('src/orphan.ts', enc(`export const O = 1;`));
    // A test that imports something else entirely
    await fs.write('tests/other.test.ts', enc(`console.log('hello');\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/orphan.ts'],
    }));

    expect(result.unusedModifiedFiles).toContain('src/orphan.ts');
    expect(result.relevantTests).not.toContain('tests/other.test.ts');
  });
});

// ---------------------------------------------------------------------------
// RT-6: Dynamic require() → coverageConfidence: 'conservative'
// ---------------------------------------------------------------------------

describe('RT-6: dynamic require → conservative confidence', () => {
  it('dynamic require() in any file → coverageConfidence: conservative', async () => {
    const { deps, fs } = makeDeps();

    // Service with a dynamic require
    await fs.write('src/service.ts', enc(`export const A = 1;\nconst m = require('./mod.js');\n`));
    await fs.write('tests/service.test.ts', enc(`import { A } from '../src/service.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
    }));

    expect(result.coverageConfidence).toBe('conservative');
    // relevantTests is still populated — conservative just means "also run full suite"
    expect(result.relevantTests).toContain('tests/service.test.ts');
  });
});

// ---------------------------------------------------------------------------
// RT-7: No dynamic require → coverageConfidence: 'exact'
// ---------------------------------------------------------------------------

describe('RT-7: no dynamic require → exact confidence', () => {
  it('all static imports → coverageConfidence: exact', async () => {
    const { deps, fs } = makeDeps();

    await fs.write('src/service.ts', enc(`export const A = 1;`));
    await fs.write('tests/service.test.ts', enc(`import { A } from '../src/service.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
    }));

    expect(result.coverageConfidence).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// RT-8: Empty file set → empty result
// ---------------------------------------------------------------------------

describe('RT-8: empty file set', () => {
  it('no JS/TS files on filesystem → empty relevantTests + all modified in unusedModifiedFiles', async () => {
    const { deps } = makeDeps();
    // fs is empty — no files at all

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
    }));

    expect(result.relevantTests).toEqual([]);
    expect(result.unusedModifiedFiles).toEqual(['src/service.ts']);
    expect(result.coverageConfidence).toBe('exact');
  });
});

// ---------------------------------------------------------------------------
// RT-9: H7 determinism — sorted output
// ---------------------------------------------------------------------------

describe('RT-9: H7 determinism — sorted output', () => {
  it('relevantTests and unusedModifiedFiles are sorted', async () => {
    const { deps, fs } = makeDeps();

    await fs.write('src/a.ts', enc(`export const A = 1;`));
    await fs.write('src/b.ts', enc(`export const B = 2;`));
    await fs.write('src/c.ts', enc(`export const C = 3;`));
    // Three test files — alphabetically out of order in creation
    await fs.write('tests/c.test.ts', enc(`import { C } from '../src/c.js';\n`));
    await fs.write('tests/a.test.ts', enc(`import { A } from '../src/a.js';\n`));
    await fs.write('tests/b.test.ts', enc(`import { B } from '../src/b.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/a.ts', 'src/b.ts', 'src/c.ts'],
    }));

    // All three tests should be relevant and sorted
    expect(result.relevantTests).toEqual([...result.relevantTests].sort());
    expect(result.unusedModifiedFiles).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// RT-10: Invalid request → ValidationError
// ---------------------------------------------------------------------------

describe('RT-10: invalid request', () => {
  it('empty modifiedFiles array → ValidationError', async () => {
    const { deps } = makeDeps();

    await expect(
      getRelevantTests(deps, makeReq({ modifiedFiles: [] })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('missing correlationId → ValidationError', async () => {
    const { deps } = makeDeps();

    await expect(
      getRelevantTests(deps, makeReq({ correlationId: '' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});

// ---------------------------------------------------------------------------
// RT-11: Custom testPatterns and custom maxDepth respected
// ---------------------------------------------------------------------------

describe('RT-11: custom testPatterns and maxDepth', () => {
  it('custom testPatterns identifies non-standard test file names', async () => {
    const { deps, fs } = makeDeps();

    await fs.write('src/service.ts', enc(`export const A = 1;`));
    // Non-standard naming: __tests__ directory
    await fs.write('__tests__/service.ts', enc(`import { A } from '../src/service.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
      testPatterns: ['__tests__/'],
    }));

    expect(result.relevantTests).toContain('__tests__/service.ts');
  });

  it('maxDepth=1 does not traverse depth-2 imports', async () => {
    const { deps, fs } = makeDeps();

    await fs.write('src/core.ts', enc(`export const CORE = 1;`));
    await fs.write('src/service.ts', enc(`import { CORE } from './core.js';\nexport const X = CORE;`));
    await fs.write('tests/service.test.ts', enc(`import { X } from '../src/service.js';\n`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/core.ts'],
      maxDepth: 1,
    }));

    // At depth=1: test → service only. service → core is depth 2, not reached.
    expect(result.relevantTests).not.toContain('tests/service.test.ts');
    expect(result.unusedModifiedFiles).toContain('src/core.ts');
  });
});

// ---------------------------------------------------------------------------
// RT-12: H13 — emitted events are content-free
// ---------------------------------------------------------------------------

describe('RT-12: H13 content-free events', () => {
  it('all emitted events contain no source content', async () => {
    const { deps, fs, emitter } = makeDeps();

    await fs.write('src/service.ts', enc(`export function secretFunc() { return 'secret'; }`));
    await fs.write('tests/service.test.ts', enc(`import { secretFunc } from '../src/service.js';\n`));

    await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
    }));

    const events = emitter.getEvents();
    expect(events.length).toBeGreaterThan(0);

    for (const event of events) {
      assertEventIsContentFree(event);
    }
  });
});

describe('rt-affinity: deterministic affinity composition', () => {
  it('selects manifest-affinity tests that do not import the modified file', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/routes.ts', enc(`export const route = '/api/widgets';\n`));
    await fs.write('tests/http.test.ts', enc(`expect('/api/widgets').toContain('widgets');\n`));
    await fs.write('.hoplon/test-affinity.json', enc(JSON.stringify({
      schemaVersion: 1,
      entries: [{
        id: 'manual:route:/api/widgets',
        source: 'manual',
        subject: {
          kind: 'route',
          id: '/api/widgets',
          definedIn: [{ path: 'src/routes.ts', selector: '/api/widgets' }],
        },
        tests: [{
          path: 'tests/http.test.ts',
          evidence: [{
            kind: 'affinity_manifest',
            path: 'tests/http.test.ts',
            manifestPath: '.hoplon/test-affinity.json',
            entryId: 'manual:route:/api/widgets',
          }],
        }],
      }],
    })));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/routes.ts'],
    }));

    expect(result.relevantTests).toEqual(['tests/http.test.ts']);
    expect(result.deterministicRelevantTests?.[0]?.sources).toContain('manual_affinity');
    expect(result.deterministicCoverage?.sourceCounts.manualAffinity).toBe(1);
    expect(result.deterministicCoverage?.manifestStatus).toBe('loaded');
  });

  it('keeps semantic candidates advisory and returns promotion suggestions', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc(`const mod = require('./dyn.js');\nexport const A = 1;`));
    await fs.write('tests/service.test.ts', enc(`expect('semantic only').toBeTruthy();\n`));
    deps.semanticSearch = async () => ({
      correlationId: 'corr-rt-001',
      projectId: 'proj-rt-test',
      advisory: true,
      status: 'AVAILABLE',
      providerStatus: 'AVAILABLE',
      providerAvailable: true,
      resultCount: 1,
      freshness: 'indexed',
      degradationReasons: [],
      topK: 3,
      matches: [{
        id: 'semantic-hit-1',
        score: 0.91,
        metadata: { path: 'tests/service.test.ts' },
        freshness: 'indexed',
      }],
    });

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts'],
      advisoryIntelligence: {
        semanticSearch: {
          topK: 3,
          resultFields: 'path_only',
        },
      },
    }));

    expect(result.relevantTests).toEqual([]);
    expect(result.semanticAdvisoryUsed).toBe(true);
    const candidate = result.diagnostics?.semanticRelevantTestCandidates?.[0];
    expect(candidate?.path).toBe('tests/service.test.ts');
    expect(candidate?.promotionSuggestion?.action).toBe('add_manual_affinity_entry');
    expect(result.deterministicCoverage?.selectedTestCount).toBe(0);
  });
});
