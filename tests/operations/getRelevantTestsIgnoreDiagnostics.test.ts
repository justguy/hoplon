import { beforeAll, describe, expect, it, vi } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { GetRelevantTestsRequest } from '../../src/hoplon/contracts/getRelevantTests.js';
import { getRelevantTests } from '../../src/hoplon/operations/getRelevantTests.js';
import type { GetRelevantTestsDeps } from '../../src/hoplon/operations/getRelevantTests.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function enc(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function makeDeps(): {
  deps: GetRelevantTestsDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
} {
  const fs = createMemFsAdapter();
  const deps: GetRelevantTestsDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter: createMemoryEmitter(),
    engineId: 'engine-t174',
    root: '/',
    config: { maxFileBytes: 524_288, parseTimeoutMs: 5_000 },
  };
  return { deps, fs };
}

function makeReq(overrides: Partial<GetRelevantTestsRequest>): GetRelevantTestsRequest {
  return {
    projectId: 'proj-t174',
    runId: 'run-t174',
    correlationId: 'corr-t174',
    modifiedFiles: ['src/service.ts'],
    maxDepth: 2,
    ...overrides,
  };
}

function semanticResult(path: string, id: string, score: number) {
  return {
    correlationId: 'corr-t174',
    projectId: 'proj-t174',
    advisory: true,
    status: 'AVAILABLE',
    providerStatus: 'AVAILABLE',
    providerAvailable: true,
    resultCount: 1,
    freshness: 'indexed',
    degradationReasons: [],
    topK: 2,
    matches: [{
      id,
      score,
      metadata: { path, projectId: 'proj-t174' },
      source: 'baseline',
      rankSource: 'baseline_lexical',
      freshness: 'indexed',
    }],
  };
}

describe('t-174 getRelevantTests ignore rules and diagnostics', () => {
  it('does not traverse root .gitignore-excluded directories', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('.gitignore', enc('.claude/\n'));
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write(
      '.claude/worktrees/agent/tests/service.test.ts',
      enc("import { service } from '../../../src/service.js';"),
    );
    await fs.write(
      'tests/service.test.ts',
      enc("import { service } from '../src/service.js';"),
    );

    const result = await getRelevantTests(deps, makeReq({
      testPatterns: ['.test.'],
    }));

    expect(result.relevantTests).toEqual(['tests/service.test.ts']);
    expect(result.unusedModifiedFiles).toEqual([]);
  });

  it('returns generic suggestions for caller-provided unmatched patterns', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write(
      'tests/service.test.ts',
      enc("import { service } from '../src/service.js';"),
    );

    const result = await getRelevantTests(deps, makeReq({
      testPatterns: ['tests/**/*.test.ts'],
    }));

    expect(result.relevantTests).toEqual([]);
    expect(result.diagnostics?.unmatchedTestPatterns).toEqual([
      {
        pattern: 'tests/**/*.test.ts',
        message: 'Pattern matched no files; testPatterns use substring matching.',
        didYouMean: ['.test.ts', 'tests/'],
        suggestions: [
          {
            value: '.test.ts',
            source: 'deterministic_exact',
            provenance: { kind: 'path_token', matched: '.test.ts' },
          },
          {
            value: 'tests/',
            source: 'deterministic_exact',
            provenance: { kind: 'path_token', matched: 'tests/' },
          },
        ],
      },
    ]);
  });

  it('adds semantic did-you-mean suggestions without selecting tests', async () => {
    const { deps, fs } = makeDeps();
    const semanticSearch = vi.fn().mockResolvedValue(
      semanticResult('tests/service.test.ts', 'tests/service.test.ts#file', 0.8),
    );
    deps.semanticSearch = semanticSearch;
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write(
      'tests/service.test.ts',
      enc("import { service } from '../src/service.js';"),
    );

    const result = await getRelevantTests(deps, makeReq({
      testPatterns: ['tests/**/*.test.ts'],
      advisoryIntelligence: { semanticSearch: { topK: 2 } },
    }));

    expect(result.relevantTests).toEqual([]);
    expect(result.diagnostics?.unmatchedTestPatterns[0]?.didYouMean).toEqual([
      '.test.ts',
      'tests/',
      'tests/service.test.ts',
    ]);
    expect(result.diagnostics?.unmatchedTestPatterns[0]?.suggestions).toContainEqual({
      value: 'tests/service.test.ts',
      source: 'semantic_search',
      provenance: {
        kind: 'semantic_match',
        matched: 'tests/service.test.ts#file',
        resultFields: 'path_only',
      },
    });
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'tests/**/*.test.ts',
        topK: 2,
        resultFields: 'path_only',
      }),
      undefined,
    );
  });

  it('does not add diagnostics for default selector patterns', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write(
      'tests/service.test.ts',
      enc("import { service } from '../src/service.js';"),
    );

    const result = await getRelevantTests(deps, makeReq({}));

    expect(result.relevantTests).toEqual(['tests/service.test.ts']);
    expect(result.diagnostics).toBeUndefined();
  });

  it('reports unmatched modified files as did-you-mean diagnostics without autocorrection', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write(
      'tests/service.test.ts',
      enc("import { service } from '../src/service.js';"),
    );

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/servcie.ts'],
      testPatterns: ['.test.'],
    }));

    expect(result.relevantTests).toEqual([]);
    expect(result.unusedModifiedFiles).toEqual(['src/servcie.ts']);
    expect(result.diagnostics?.unmatchedModifiedFiles).toEqual([
      {
        path: 'src/servcie.ts',
        message: 'Modified file was not found in the scanned static import graph.',
        didYouMean: ['src/service.ts'],
        suggestions: [
          {
            value: 'src/service.ts',
            source: 'deterministic_exact',
            provenance: { kind: 'path_token', matched: 'src/service.ts' },
          },
        ],
      },
    ]);
  });

  it('does not promote semantic candidates when static coverage is exact', async () => {
    const { deps, fs } = makeDeps();
    const semanticSearch = vi.fn();
    deps.semanticSearch = semanticSearch;
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write(
      'tests/service.test.ts',
      enc("import { service } from '../src/service.js';"),
    );

    const result = await getRelevantTests(deps, makeReq({
      testPatterns: ['.test.'],
      advisoryIntelligence: { semanticSearch: { topK: 3 } },
    }));

    expect(result.relevantTests).toEqual(['tests/service.test.ts']);
    expect(result.diagnostics).toBeUndefined();
    expect(semanticSearch).not.toHaveBeenCalled();
  });

  it('adds semantic relevant-test candidates only for static blind spots', async () => {
    const { deps, fs } = makeDeps();
    const semanticSearch = vi.fn().mockResolvedValue(
      semanticResult('tests/config.test.ts', 'tests/config.test.ts#file', 0.9),
    );
    deps.semanticSearch = semanticSearch;
    await fs.write('src/service.ts', enc('export const service = 1;'));
    await fs.write('tests/config.test.ts', enc('import "../src/service.js";'));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['package.json'],
      testPatterns: ['.test.'],
      advisoryIntelligence: {
        semanticSearch: { topK: 2, resultFields: 'path_and_symbol' },
      },
    }));

    expect(result.coverageConfidence).toBe('conservative');
    expect(result.relevantTests).toEqual([]);
    expect(result.diagnostics?.blindSpots).toEqual([
      {
        source: 'static_oracle',
        reason: 'config_or_package_file',
        path: 'package.json',
        message: 'Config/package changes can affect tests through framework tooling.',
      },
    ]);
    expect(result.diagnostics?.semanticRelevantTestCandidates).toEqual([
      {
        path: 'tests/config.test.ts',
        advisoryOnly: true,
        reason: 'Static relevant-test coverage is degraded or has a named blind spot.',
        source: 'semantic_search',
        provenance: {
          blindSpotReason: 'config_or_package_file',
          resultFields: 'path_and_symbol',
          semanticSearch: {
            id: 'tests/config.test.ts#file',
            score: 0.9,
            status: 'AVAILABLE',
            freshness: 'indexed',
            degradationReasons: [],
          },
        },
      },
    ]);
    expect(semanticSearch).toHaveBeenCalledWith(
      expect.objectContaining({
        query: 'tests covering package.json',
        topK: 2,
        resultFields: 'path_and_symbol',
      }),
      undefined,
    );
  });
});
