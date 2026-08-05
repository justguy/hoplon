import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { SeeCodebaseEnvelopeSchema } from '../../src/hoplon/contracts/seeCodebase.js';
import { seeCodebase, type SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(source: string): Uint8Array {
  return new TextEncoder().encode(source);
}

let sharedCI: CodeIntelligenceAdapter;
beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeStack(): {
  deps: SeeCodebaseDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
} {
  const fs = createMemFsAdapter();
  const deps: SeeCodebaseDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter: createMemoryEmitter(),
    engineId: 'test-engine',
    root: '/',
    config: { maxFileBytes: 1024 * 1024, parseTimeoutMs: 5000 },
    packContext: async () => { throw new Error('packContext should not run'); },
    extractStructuralTemplate: async () => {
      throw new Error('extractStructuralTemplate should not run');
    },
    searchSymbols: async () => { throw new Error('searchSymbols should not run'); },
    describeProject: async () => { throw new Error('describeProject should not run'); },
  };
  return { deps, fs };
}

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-t106',
    runId: 'run-t106-001',
    correlationId: 'corr-t106-001',
    ...overrides,
  };
}

describe('seeCodebase AST node-targeted reads (t-106)', () => {
  it('returns isolated nested method content with stable AST identity', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/service.ts', enc(
      'export class Service {\n' +
        '  helper() { return 0; }\n' +
        '  target() { return 1; }\n' +
        '}\n',
    ));

    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{
        kind: 'ast_node',
        file: 'src/service.ts',
        selector: { kind: 'symbol_path', symbolPath: ['Service', 'target'] },
      }],
    }));

    expect(env.ok).toBe(true);
    expect(() => SeeCodebaseEnvelopeSchema.parse(env)).not.toThrow();
    if (!env.ok) throw new Error('unreachable');
    const result = env.data.results[0];
    if (!result || result.kind !== 'ast_node') throw new Error('expected ast_node');
    expect(result.content).toContain('target() { return 1; }');
    expect(result.content).not.toContain('helper()');
    expect(result.identity).toMatchObject({
      path: 'src/service.ts',
      symbolPath: ['Service', 'target'],
      name: 'target',
      nodeKind: 'method_definition',
      language: 'typescript',
    });
    expect(result.identity.stableId).toMatch(/^ast-node:v1:/u);
    expect(result.identity.contentSha256).toMatch(/^[a-f0-9]{64}$/u);
    expect(result.readProvenance.kind).toBe('live_filesystem');
    expect(env.provenance?.primitivesUsed).toEqual(['readAstNode']);
    expect(env.provenance?.selectedPath).toBe('structural');
  });

  it('returns AMBIGUOUS_TARGET for overload or duplicate symbol-path matches', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/overload.ts', enc(
      'function parse(value: string): string;\n' +
        'function parse(value: number): number;\n' +
        'function parse(value: string | number) { return value; }\n',
    ));

    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{
        kind: 'ast_node',
        file: 'src/overload.ts',
        selector: { kind: 'symbol_path', symbolPath: ['parse'] },
      }],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('AMBIGUOUS_TARGET');
    expect('data' in env).toBe(false);
    expect(env.provenance?.primitivesUsed).toEqual([]);
  });

  it('returns UNRESOLVED_TARGET without raw fallback for missing nodes', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/service.ts', enc('export class Service { only() {} }\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{
        kind: 'ast_node',
        file: 'src/service.ts',
        selector: { kind: 'symbol_path', symbolPath: ['Service', 'missing'] },
      }],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('UNRESOLVED_TARGET');
    expect(env.provenance?.primitivesUsed).toEqual([]);
  });

  it('returns UNSUPPORTED_TARGET for generated JS/TS files', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/generated/service.ts', enc('export function generated() {}\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{
        kind: 'ast_node',
        file: 'src/generated/service.ts',
        selector: { kind: 'symbol_path', symbolPath: ['generated'] },
      }],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('UNSUPPORTED_TARGET');
    expect(env.provenance?.primitivesUsed).toEqual([]);
  });

  it('returns OUT_OF_SCOPE_TARGET when strict engagement excludes the node file', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/other/service.ts', enc('export function outside() {}\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      engagement: { token: 'strict-token', folder: 'src/allowed', principalId: null },
      targets: [{
        kind: 'ast_node',
        file: 'src/other/service.ts',
        selector: { kind: 'symbol_path', symbolPath: ['outside'] },
      }],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('OUT_OF_SCOPE_TARGET');
    expect(env.provenance?.primitivesUsed).toEqual([]);
  });

  it('returns STALE_TARGET when the caller-provided identity no longer matches', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/service.ts', enc('export function target() { return 1; }\n'));
    const first = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{
        kind: 'ast_node',
        file: 'src/service.ts',
        selector: { kind: 'symbol_path', symbolPath: ['target'] },
      }],
    }));
    if (!first.ok || first.data.results[0]?.kind !== 'ast_node') {
      throw new Error('expected initial ast_node');
    }
    await fs.write('src/service.ts', enc('export function target() { return 2; }\n'));

    const second = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{
        kind: 'ast_node',
        file: 'src/service.ts',
        selector: { kind: 'symbol_path', symbolPath: ['target'] },
        expectedIdentity: { stableId: first.data.results[0].identity.stableId },
      }],
    }));

    expect(second.ok).toBe(false);
    if (second.ok) throw new Error('unreachable');
    expect(second.error.kind).toBe('STALE_TARGET');
    expect(second.provenance?.primitivesUsed).toEqual([]);
  });

  it('returns DUPLICATE_TARGET for repeated node requests in one envelope', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/service.ts', enc('export function target() { return 1; }\n'));
    const target = {
      kind: 'ast_node' as const,
      file: 'src/service.ts',
      selector: { kind: 'symbol_path' as const, symbolPath: ['target'] },
    };
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [target, target],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('DUPLICATE_TARGET');
    expect(env.provenance?.primitivesUsed).toEqual([]);
  });
});
