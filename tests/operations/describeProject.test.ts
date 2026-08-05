/**
 * tests/operations/describeProject.test.ts — t-056 targeted proof.
 *
 * Proof requirements:
 *  DP-1  File counts include every JS/TS extension; per-language breakdown is exact.
 *  DP-2  Non-JS/TS files are excluded from totals (file-walker is JS/TS only).
 *  DP-3  Symbol counts are exact for the parsed sample.
 *  DP-4  truncated=true when total > maxFiles; filesScanned reflects the sample.
 *  DP-5  Determinism (H7): repeated runs produce byte-identical output.
 *  DP-6  Sample paths are sorted and bounded by samplePathsPerLanguage.
 *  DP-7  H13: emitted events carry no source content.
 *  DP-8  Sampled-file structural failures are surfaced explicitly.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describeProject } from '../../src/hoplon/operations/describeProject.js';
import type { DescribeProjectDeps } from '../../src/hoplon/operations/describeProject.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { DescribeProjectRequest } from '../../src/hoplon/contracts/describeProject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let sharedCI: CodeIntelligenceAdapter;
beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeDeps(): {
  deps: DescribeProjectDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const deps: DescribeProjectDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-engine',
    root: '/',
    config: { maxFileBytes: 524288, parseTimeoutMs: 5000 },
  };
  return { deps, fs, emitter };
}

function makeReq(overrides: Partial<DescribeProjectRequest> = {}): DescribeProjectRequest {
  return {
    projectId: 'proj-dp',
    runId: 'run-dp-001',
    correlationId: 'corr-dp-001',
    ...overrides,
  };
}

describe('describeProject', () => {
  it('DP-1: per-language file breakdown is exact across .js/.ts/.tsx', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.js', enc('export const a = 1;\n'));
    await fs.write('src/b.ts', enc('export const b = 1;\n'));
    await fs.write('src/c.tsx', enc('export const c = 1;\n'));
    const result = await describeProject(deps, makeReq());
    expect(result.files.total).toBe(3);
    const counts = new Map(
      result.files.byLanguage.map((b) => [b.language, b.fileCount]),
    );
    expect(counts.get('javascript')).toBe(1);
    expect(counts.get('typescript')).toBe(1);
    expect(counts.get('tsx')).toBe(1);
  });

  it('DP-2: README.md and other non-JS/TS files do not inflate the count', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export const a = 1;\n'));
    await fs.write('README.md', enc('# hi\n'));
    await fs.write('package.json', enc('{}\n'));
    const result = await describeProject(deps, makeReq());
    expect(result.files.total).toBe(1);
  });

  it('DP-3: aggregated symbol counts are exact for the parsed sample', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/mix.ts',
      enc(
        [
          "import { x } from './x.js';",
          'export function fnA(){}',
          'export function fnB(){}',
          'export class Cls {}',
          'export interface IBar { v: number }',
          'export type Alias = string',
        ].join('\n') + '\n',
      ),
    );
    const result = await describeProject(deps, makeReq());
    expect(result.symbols.imports).toBe(1);
    expect(result.symbols.functions).toBe(2);
    expect(result.symbols.classes).toBe(1);
    expect(result.symbols.types).toBe(2); // interface + type alias
    // Each `export` clause contributes one extract-exports match.
    expect(result.symbols.exports).toBeGreaterThanOrEqual(5);
  });

  it('DP-4: truncated=true when the project has more files than maxFiles', async () => {
    const { deps, fs } = makeDeps();
    for (let i = 0; i < 5; i++) {
      await fs.write(`src/file${i}.ts`, enc('export const x = 1;\n'));
    }
    const result = await describeProject(deps, makeReq({ maxFiles: 2 }));
    expect(result.files.total).toBe(5);
    expect(result.filesScanned).toBe(2);
    expect(result.truncated).toBe(true);
  });

  it('DP-5: H7 — repeated runs produce byte-identical output', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('export class A {}\n'));
    await fs.write('src/b.ts', enc('export interface B {}\n'));
    const a = await describeProject(deps, makeReq());
    const b = await describeProject(deps, makeReq());
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('DP-6: sample paths are sorted and respect samplePathsPerLanguage', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/zeta.ts', enc('export const z = 1;\n'));
    await fs.write('src/alpha.ts', enc('export const a = 1;\n'));
    await fs.write('src/beta.ts', enc('export const b = 1;\n'));
    const result = await describeProject(deps, makeReq({ samplePathsPerLanguage: 2 }));
    const tsBreak = result.files.byLanguage.find((b) => b.language === 'typescript');
    expect(tsBreak).toBeDefined();
    expect(tsBreak?.fileCount).toBe(3);
    expect(tsBreak?.samplePaths.length).toBe(2);
    const sorted = [...(tsBreak?.samplePaths ?? [])].sort();
    expect(tsBreak?.samplePaths).toEqual(sorted);
  });

  it('DP-7: H13 — emitted events carry no source content', async () => {
    const { deps, fs, emitter } = makeDeps();
    await fs.write('src/x.ts', enc('export function x(){}\n'));
    await describeProject(deps, makeReq());
    for (const evt of emitter.getEvents()) assertEventIsContentFree(evt);
  });

  it('DP-8: sampled-file parse failures are surfaced explicitly', async () => {
    const { deps, fs } = makeDeps();
    deps.config.maxFileBytes = 25;
    await fs.write('src/a.ts', enc('export function ok(){}\n'));
    await fs.write('src/b.ts', enc('export const thisFileIsTooLarge = 1;\n'));
    const result = await describeProject(deps, makeReq());
    expect(result.files.total).toBe(2);
    expect(result.filesScanned).toBe(2);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe('src/b.ts');
    expect(result.failures[0]?.reason).toBe('parse_failure');
    expect(result.symbols.functions).toBe(1);
  });
});
