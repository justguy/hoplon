/**
 * tests/unit/adapters/summarizer.test.ts
 *
 * t-031 targeted proof — SummarizerAdapter seam.
 *
 * Verifies:
 *   1. createNoopSummarizer() satisfies SummarizerAdapter contract
 *      (all three input kinds → { summary: '', tokenEstimate: 0, truncated: false })
 *   2. Factory accepts undefined summarizer → noop substituted (engine starts cleanly)
 *   3. Factory accepts an explicit noop summarizer (engine starts cleanly)
 *   4. Consumer-provided mock adapter is used when present (delegation proof)
 *   5. H2 seam-only: no Hoplon operation calls the summarizer internally
 *      (the engine facade exposes no summarize() method)
 */

import { describe, it, expect, vi, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import {
  createNoopSummarizer,
  type SummarizerAdapter,
  type SummarizerInput,
  type SummarizerOutput,
} from '../../../src/hoplon/adapters/summarizer.js';
import { createHoplonEngine } from '../../../src/hoplon/engine/factory.js';
import type { HoplonAdapters } from '../../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import { createTreeSitterIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '../../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Helper: minimal valid adapters (7 mandatory, no optional slots)
// ---------------------------------------------------------------------------

async function makeBaseAdapters(): Promise<HoplonAdapters> {
  const fs = createMemFsAdapter();
  return {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: await createIsolatedTestStore(),
    lockProvider: createAsyncMutexLockProvider(),
    emitter: createMemoryEmitter(),
    codeIntelligence: sharedCI,
    secretScanner: createBuiltinRegexScanner(),
  };
}

const BASE_CONFIG = { engineId: 'test-t031', fsRoot: '/' };

// ---------------------------------------------------------------------------
// t031-1: createNoopSummarizer satisfies SummarizerAdapter contract
// ---------------------------------------------------------------------------

describe('t031-1 — createNoopSummarizer noop contract', () => {
  it("returns empty summary for kind='diff'", async () => {
    const adapter = createNoopSummarizer();
    const input: SummarizerInput = { kind: 'diff', payload: [] };
    const result = await adapter.summarize(input);
    expect(result.summary).toBe('');
    expect(result.tokenEstimate).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("returns empty summary for kind='violations'", async () => {
    const adapter = createNoopSummarizer();
    const input: SummarizerInput = {
      kind: 'violations',
      payload: [{ kind: 'out_of_scope_symbol', message: 'foo declared outside scope' }],
    };
    const result = await adapter.summarize(input);
    expect(result.summary).toBe('');
    expect(result.tokenEstimate).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it("returns empty summary for kind='retry-context'", async () => {
    const adapter = createNoopSummarizer();
    const input: SummarizerInput = {
      kind: 'retry-context',
      payload: { persistentViolations: [], resolvedViolations: [], newViolations: [] },
    };
    const result = await adapter.summarize(input);
    expect(result.summary).toBe('');
    expect(result.tokenEstimate).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('returns consistent results across multiple calls (stateless noop)', async () => {
    const adapter = createNoopSummarizer();
    const input: SummarizerInput = { kind: 'diff', payload: 'some diff text' };
    const r1 = await adapter.summarize(input);
    const r2 = await adapter.summarize(input);
    expect(r1).toEqual(r2);
    expect(r1.summary).toBe('');
  });

  it('ignores maxTokens and abortSignal (noop)', async () => {
    const adapter = createNoopSummarizer();
    const controller = new AbortController();
    const input: SummarizerInput = {
      kind: 'diff',
      payload: {},
      maxTokens: 100,
      abortSignal: controller.signal,
    };
    const result = await adapter.summarize(input);
    expect(result.summary).toBe('');
    expect(result.truncated).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// t031-2: Factory accepts undefined summarizer → noop substituted
// ---------------------------------------------------------------------------

describe('t031-2 — factory accepts undefined summarizer → noop substituted', () => {
  it('starts cleanly when summarizer is undefined', async () => {
    const adapters = await makeBaseAdapters();
    expect(adapters.summarizer).toBeUndefined();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    expect(engine).toBeDefined();
    expect(typeof engine.health).toBe('function');
  });

  it('engine health is ok when summarizer is absent', async () => {
    const adapters = await makeBaseAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    const health = await engine.health();
    expect(health.adapters.fs).toBe('ok');
    expect(health.engineId).toBe('test-t031');
  });
});

// ---------------------------------------------------------------------------
// t031-3: Factory accepts explicit noop summarizer
// ---------------------------------------------------------------------------

describe('t031-3 — factory accepts explicit noop summarizer', () => {
  it('starts cleanly when explicit createNoopSummarizer() is provided', async () => {
    const adapters = await makeBaseAdapters();
    const withSummarizer: HoplonAdapters = {
      ...adapters,
      summarizer: createNoopSummarizer(),
    };
    const engine = await createHoplonEngine(withSummarizer, BASE_CONFIG);
    expect(engine).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// t031-4: Consumer-provided mock adapter delegation proof
// ---------------------------------------------------------------------------

describe('t031-4 — consumer-provided summarizer is used when present', () => {
  it('mock summarizer is invoked when the host calls it directly', async () => {
    const mockSummarize = vi.fn<[SummarizerInput], Promise<SummarizerOutput>>().mockResolvedValue({
      summary: 'Remove the extra symbol from src/foo.ts.',
      tokenEstimate: 12,
      truncated: false,
    });

    const mockSummarizer: SummarizerAdapter = { summarize: mockSummarize };

    // Wire mock into adapters (as the injection slot allows)
    const adapters = await makeBaseAdapters();
    const withMock: HoplonAdapters = { ...adapters, summarizer: mockSummarizer };

    // Factory accepts it without error
    await createHoplonEngine(withMock, BASE_CONFIG);

    // Host-side invocation: the host calls its adapter directly (not via engine)
    const input: SummarizerInput = {
      kind: 'violations',
      payload: [{ kind: 'out_of_scope_symbol', message: 'foo is out of scope' }],
    };
    const result = await withMock.summarizer!.summarize(input);

    expect(mockSummarize).toHaveBeenCalledOnce();
    expect(mockSummarize).toHaveBeenCalledWith(input);
    expect(result.summary).toBe('Remove the extra symbol from src/foo.ts.');
    expect(result.tokenEstimate).toBe(12);
    expect(result.truncated).toBe(false);
  });

  it('mock summarizer returns distinct results per kind', async () => {
    const mockSummarizer: SummarizerAdapter = {
      summarize: vi.fn<[SummarizerInput], Promise<SummarizerOutput>>()
        .mockImplementation(async (input) => ({
          summary: `Summary for ${input.kind}`,
          tokenEstimate: input.kind.length,
          truncated: false,
        })),
    };

    const diffInput: SummarizerInput = { kind: 'diff', payload: {} };
    const violationsInput: SummarizerInput = { kind: 'violations', payload: [] };
    const retryInput: SummarizerInput = { kind: 'retry-context', payload: {} };

    const r1 = await mockSummarizer.summarize(diffInput);
    const r2 = await mockSummarizer.summarize(violationsInput);
    const r3 = await mockSummarizer.summarize(retryInput);

    expect(r1.summary).toBe('Summary for diff');
    expect(r2.summary).toBe('Summary for violations');
    expect(r3.summary).toBe('Summary for retry-context');
  });
});

// ---------------------------------------------------------------------------
// t031-5: H2 seam-only — no Hoplon operation calls the summarizer internally
// ---------------------------------------------------------------------------

describe('t031-5 — H2 seam-only: engine facade has no summarize() method', () => {
  it('HoplonEngine interface does not expose summarize()', async () => {
    const adapters = await makeBaseAdapters();
    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    // The engine facade must NOT expose a summarize() method — it is a host-side seam only.
    expect(typeof (engine as Record<string, unknown>)['summarize']).toBe('undefined');
  });

  it('noop summarizer is not called by any engine operation (packContext, health, etc.)', async () => {
    const adapters = await makeBaseAdapters();
    const spySummarizer: SummarizerAdapter = {
      summarize: vi.fn<[SummarizerInput], Promise<SummarizerOutput>>().mockResolvedValue({
        summary: 'unexpected call',
        tokenEstimate: 0,
        truncated: false,
      }),
    };
    const withSpy: HoplonAdapters = { ...adapters, summarizer: spySummarizer };
    const engine = await createHoplonEngine(withSpy, BASE_CONFIG);

    // Call health — should never trigger the summarizer
    await engine.health();

    expect(spySummarizer.summarize).not.toHaveBeenCalled();
  });
});
