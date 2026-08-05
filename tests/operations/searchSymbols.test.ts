/**
 * tests/operations/searchSymbols.test.ts — t-056 targeted proof.
 *
 * Proof requirements:
 *  SS-1  Function declaration matched by name regex.
 *  SS-2  Class, interface, type-alias, enum declarations all matched.
 *  SS-3  Class methods matched only when 'method' kind is enabled.
 *  SS-4  Exported declarations matched via the 'export' kind.
 *  SS-5  Names not matching the regex are excluded.
 *  SS-6  Determinism (H7): two runs produce byte-identical results.
 *  SS-7  maxResults truncation surfaces as `truncated: true`.
 *  SS-8  Invalid regex → ValidationError.
 *  SS-9  No files (and no project walk hits) → empty matches, filesScanned=0.
 *  SS-10 H13: emitted events carry no symbol names or text.
 *  SS-11 Walks the project tree when `files` is omitted (skips node_modules, etc).
 *  SS-12 Structural failures are surfaced once per file, not once per query.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { searchSymbols } from '../../src/hoplon/operations/searchSymbols.js';
import type { SearchSymbolsDeps } from '../../src/hoplon/operations/searchSymbols.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import type { SearchSymbolsRequest } from '../../src/hoplon/contracts/searchSymbols.js';

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
  deps: SearchSymbolsDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const deps: SearchSymbolsDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-engine',
    root: '/',
    config: { maxFileBytes: 524288, parseTimeoutMs: 5000 },
  };
  return { deps, fs, emitter };
}

function makeReq(overrides: Partial<SearchSymbolsRequest> = {}): SearchSymbolsRequest {
  return {
    projectId: 'proj-ss',
    runId: 'run-ss-001',
    correlationId: 'corr-ss-001',
    namePattern: '.*',
    files: ['src/sample.ts'],
    ...overrides,
  };
}

describe('searchSymbols', () => {
  it('SS-1: matches a function declaration by regex', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/sample.ts', enc('export function createFoo(): void {}\n'));
    const result = await searchSymbols(deps, makeReq({ namePattern: '^createFoo$' }));
    const fn = result.matches.find((m) => m.kind === 'function');
    expect(fn).toBeDefined();
    expect(fn?.name).toBe('createFoo');
  });

  it('SS-2: matches class, interface, type alias, enum declarations', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/decls.ts',
      enc(
        [
          'export class FooService {}',
          'export interface IBar { x: number }',
          'export type Baz = string',
          'export enum Color { Red, Green }',
        ].join('\n') + '\n',
      ),
    );
    const result = await searchSymbols(deps, makeReq({
      files: ['src/decls.ts'],
      namePattern: '.+',
    }));
    const kinds = new Set(result.matches.map((m) => m.kind));
    expect(kinds.has('class')).toBe(true);
    expect(kinds.has('interface')).toBe(true);
    expect(kinds.has('type')).toBe(true);
    expect(kinds.has('enum')).toBe(true);
  });

  it('SS-3: methods only appear when the method kind is enabled', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/cls.ts',
      enc('export class Svc { run(): void {} stop(): void {} }\n'),
    );
    const off = await searchSymbols(deps, makeReq({
      files: ['src/cls.ts'],
      namePattern: '.+',
      kinds: ['class'],
    }));
    expect(off.matches.some((m) => m.kind === 'method')).toBe(false);

    const on = await searchSymbols(deps, makeReq({
      files: ['src/cls.ts'],
      namePattern: '.+',
      kinds: ['method'],
    }));
    const methodNames = on.matches
      .filter((m) => m.kind === 'method')
      .map((m) => m.name)
      .sort();
    expect(methodNames).toEqual(['run', 'stop']);
  });

  it('SS-4: matches exported declarations via the export kind', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/exp.ts', enc('export function exposed(): void {}\n'));
    const result = await searchSymbols(deps, makeReq({
      files: ['src/exp.ts'],
      namePattern: '^exposed$',
      kinds: ['export'],
    }));
    const exp = result.matches.find((m) => m.kind === 'export');
    expect(exp).toBeDefined();
    expect(exp?.name).toBe('exposed');
  });

  it('SS-5: names not matching the regex are excluded', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/many.ts',
      enc('export function alpha(){}; export function beta(){};'),
    );
    const result = await searchSymbols(deps, makeReq({
      files: ['src/many.ts'],
      namePattern: '^alpha$',
      kinds: ['function'],
    }));
    expect(result.matches.map((m) => m.name)).toEqual(['alpha']);
  });

  it('SS-6: H7 — repeated runs produce byte-identical output', async () => {
    const { deps, fs } = makeDeps();
    await fs.write(
      'src/d.ts',
      enc('export class A {}\nexport function b(){}\nexport interface C {}\n'),
    );
    const a = await searchSymbols(deps, makeReq({ files: ['src/d.ts'], namePattern: '.+' }));
    const b = await searchSymbols(deps, makeReq({ files: ['src/d.ts'], namePattern: '.+' }));
    expect(JSON.stringify(a)).toBe(JSON.stringify(b));
  });

  it('SS-7: maxResults truncates and reports truncated=true', async () => {
    const { deps, fs } = makeDeps();
    const lines: string[] = [];
    for (let i = 0; i < 10; i++) lines.push(`export function fn${i}(){}`);
    await fs.write('src/many.ts', enc(lines.join('\n') + '\n'));
    const result = await searchSymbols(deps, makeReq({
      files: ['src/many.ts'],
      namePattern: '^fn\\d$',
      kinds: ['function'],
      maxResults: 3,
    }));
    expect(result.truncated).toBe(true);
    expect(result.matches.length).toBe(3);
  });

  it('SS-8: invalid regex throws ValidationError', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/x.ts', enc('export function x(){}\n'));
    await expect(
      searchSymbols(deps, makeReq({ namePattern: '(' })),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('SS-9: empty file list returns an empty matches envelope', async () => {
    const { deps } = makeDeps();
    const result = await searchSymbols(deps, makeReq({ files: [] }));
    expect(result.matches).toEqual([]);
    expect(result.filesScanned).toBe(0);
    expect(result.truncated).toBe(false);
  });

  it('SS-10: H13 — emitted events carry no source content', async () => {
    const { deps, fs, emitter } = makeDeps();
    await fs.write('src/e.ts', enc('export function emitted(){}\n'));
    await searchSymbols(deps, makeReq({ files: ['src/e.ts'], namePattern: '.+' }));
    for (const evt of emitter.getEvents()) assertEventIsContentFree(evt);
  });

  it('SS-11: when files is omitted, the project tree is walked', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/walked.ts', enc('export function walked(){}\n'));
    await fs.write('node_modules/skip.ts', enc('export function skipped(){}\n'));
    await fs.write('.hoplon/skip2.ts', enc('export function skipped2(){}\n'));
    const result = await searchSymbols(deps, makeReq({
      files: undefined,
      namePattern: '.+',
      kinds: ['function'],
    }));
    const names = result.matches.map((m) => m.name).sort();
    expect(names).toContain('walked');
    expect(names).not.toContain('skipped');
    expect(names).not.toContain('skipped2');
  });

  it('SS-12: structural failures are deduplicated per file', async () => {
    const { deps, fs } = makeDeps();
    deps.config.maxFileBytes = 25;
    await fs.write('src/too-large.ts', enc('export const thisFileIsTooLarge = 1;\n'));
    const result = await searchSymbols(deps, makeReq({
      files: ['src/too-large.ts'],
      namePattern: '.+',
    }));
    expect(result.matches).toEqual([]);
    expect(result.failures).toHaveLength(1);
    expect(result.failures[0]?.path).toBe('src/too-large.ts');
    expect(result.failures[0]?.reason).toBe('parse_failure');
  });
});
