import { beforeAll, describe, expect, it } from 'vitest';
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
    engineId: 'engine-t112',
    root: '/',
    config: { maxFileBytes: 524_288, parseTimeoutMs: 5_000 },
  };
  return { deps, fs };
}

function makeReq(overrides: Partial<GetRelevantTestsRequest>): GetRelevantTestsRequest {
  return {
    projectId: 'proj-t112',
    runId: 'run-t112',
    correlationId: 'corr-t112',
    modifiedFiles: ['src/service.ts'],
    testPatterns: ['.test.', '.spec.', '/tests/'],
    maxDepth: 2,
    ...overrides,
  };
}

describe('t-112 getRelevantTests conservative fallback corpus', () => {
  it('marks dynamic import projects conservative instead of exact', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/loader.ts',
      enc(`export async function load(name: string) { return import(\`./plugins/\${name}.js\`); }`),
    );
    await fs.write('src/plugins/alpha.ts', enc(`export const alpha = 1;`));
    await fs.write('tests/loader.test.ts', enc(`import { load } from '../src/loader.js';`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/plugins/alpha.ts'],
    }));

    expect(result.coverageConfidence).toBe('conservative');
    expect(result.unusedModifiedFiles).toContain('src/plugins/alpha.ts');
  });

  it('marks generated-file imports conservative while preserving direct relevance', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/generated/client.generated.ts', enc(`export const client = 1;`));
    await fs.write(
      'tests/client.test.ts',
      enc(`import { client } from '../src/generated/client.generated.js';`),
    );

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/generated/client.generated.ts'],
    }));

    expect(result.coverageConfidence).toBe('conservative');
    expect(result.relevantTests).toEqual(['tests/client.test.ts']);
    expect(result.unusedModifiedFiles).toEqual([]);
  });

  it('marks package scripts and config-driven wiring conservative', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc(`export const service = 1;`));
    await fs.write('tests/service.test.ts', enc(`import { service } from '../src/service.js';`));
    await fs.write('package.json', enc(`{"scripts":{"test":"vitest --runInBand"}}`));
    await fs.write('vite.config.ts', enc(`export default {}`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['package.json', 'vite.config.ts'],
    }));

    expect(result.coverageConfidence).toBe('conservative');
    expect(result.relevantTests).toEqual([]);
    expect(result.unusedModifiedFiles).toEqual(['package.json', 'vite.config.ts']);
  });

  it('marks non-code asset coupling conservative instead of exact', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/theme.css', enc(`:root { color: red; }`));
    await fs.write('src/view.ts', enc(`import './theme.css'; export const view = true;`));
    await fs.write('tests/view.test.ts', enc(`import { view } from '../src/view.js';`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/theme.css'],
    }));

    expect(result.coverageConfidence).toBe('conservative');
    expect(result.relevantTests).toEqual([]);
    expect(result.unusedModifiedFiles).toEqual(['src/theme.css']);
  });

  it('keeps exact direct hits but downgrades mixed unsupported inputs to conservative', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/service.ts', enc(`export const service = 1;`));
    await fs.write('tests/service.test.ts', enc(`import { service } from '../src/service.js';`));
    await fs.write('package.json', enc(`{"scripts":{"test":"vitest"}}`));

    const result = await getRelevantTests(deps, makeReq({
      modifiedFiles: ['src/service.ts', 'package.json'],
    }));

    expect(result.coverageConfidence).toBe('conservative');
    expect(result.relevantTests).toEqual(['tests/service.test.ts']);
    expect(result.unusedModifiedFiles).toEqual(['package.json']);
  });
});
