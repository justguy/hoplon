import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seeCodebase, type SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';
import { packContext, type PackContextDeps } from '../../src/hoplon/operations/packContext.js';
import {
  extractStructuralTemplate,
  type ExtractStructuralTemplateDeps,
} from '../../src/hoplon/operations/extractStructuralTemplate.js';
import { searchSymbols, type SearchSymbolsDeps } from '../../src/hoplon/operations/searchSymbols.js';
import {
  describeProject,
  type DescribeProjectDeps,
} from '../../src/hoplon/operations/describeProject.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

const STRICT_ENGAGEMENT = {
  token: 'strict-token',
  folder: '',
  principalId: null,
};

const SRC_ENGAGEMENT = {
  token: 'strict-token-src',
  folder: 'src',
  principalId: null,
};

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let sharedCI: CodeIntelligenceAdapter;
beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeStack(rootOverride = '/'): {
  deps: SeeCodebaseDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const root = rootOverride;
  const config = { maxFileBytes: 524288, parseTimeoutMs: 5000 };
  const engineId = 'test-engine';
  const packDeps = { fs, codeIntelligence: sharedCI, emitter, engineId, root, config } as PackContextDeps;
  const templateDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  } as ExtractStructuralTemplateDeps;
  const symbolDeps: SearchSymbolsDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  };
  const projectDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  } as DescribeProjectDeps;
  return {
    fs,
    deps: {
      fs,
      emitter,
      engineId,
      root,
      config,
      packContext: (req, signal) => packContext(packDeps, req, signal),
      extractStructuralTemplate: (req, signal) =>
        extractStructuralTemplate(templateDeps, req, signal),
      searchSymbols: (req, signal) => searchSymbols(symbolDeps, req, signal),
      describeProject: (req, signal) => describeProject(projectDeps, req, signal),
    },
  };
}

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-t098',
    runId: 'run-t098-001',
    correlationId: 'corr-t098-001',
    engagement: STRICT_ENGAGEMENT,
    ...overrides,
  };
}

describe('seeCodebase strict code-adjacent file policy (t-098)', () => {
  it.each([
    ['package manifest', 'package.json', '{ "scripts": { "test": "vitest" } }\n'],
    ['TypeScript config', 'tsconfig.json', '{ "compilerOptions": { "strict": true } }\n'],
    ['test fixture', 'tests/fixtures/user.json', '{ "name": "Ada" }\n'],
    ['prompt/source doc', 'prompts/review.prompt.md', '# Review prompt\n'],
    ['root project source doc', 'PHALANX_VISION.md', '# Vision\n'],
    ['generated report', 'reports/static.report.md', '# Report\n'],
  ])('reads approved %s text', async (_label, path, content) => {
    const { deps, fs } = makeStack();
    await fs.write(path, enc(content));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.path).toBe(path);
    expect(raw.content).toBe(content);
    expect(env.provenance?.routingFactors.fileKindSupport).toBe('other_supported');
  });

  it('searches approved classes without scanning env/log files', async () => {
    const { deps, fs } = makeStack();
    await fs.write('package.json', enc('{ "name": "needle-t098" }\n'));
    await fs.write('docs/guide.md', enc('needle-t098 in docs\n'));
    await fs.write('tests/fixtures/data.json', enc('{ "marker": "needle-t098" }\n'));
    await fs.write('.env', enc('SECRET=needle-t098\n'));
    await fs.write('logs/runtime.log', enc('needle-t098\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{ kind: 'pattern', regex: 'needle-t098' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.matches.map((m) => m.path).sort()).toEqual([
      'docs/guide.md',
      'package.json',
      'tests/fixtures/data.json',
    ]);
  });

  it('accepts an absolute engagement folder that resolves to the adapter root', async () => {
    const { deps, fs } = makeStack('/workspace/project-phalanx');
    await fs.write('src/provider.ts', enc('export const provider = "needle-t173";\n'));
    await fs.write('tests/provider.test.ts', enc('expect("needle-t173").toBeTruthy();\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      strict: true,
      engagement: {
        token: 'strict-token-absolute',
        folder: '/workspace/project-phalanx',
        principalId: null,
      },
      targets: [{
        kind: 'pattern',
        regex: 'needle-t173',
        scope: ['src', 'tests'],
      }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.matches.map((m) => m.path).sort()).toEqual([
      'src/provider.ts',
      'tests/provider.test.ts',
    ]);
  });

  it('accepts an absolute engagement subfolder for in-folder raw reads', async () => {
    const { deps, fs } = makeStack('/workspace/project-phalanx');
    await fs.write('src/provider.ts', enc('export const provider = "ok";\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      strict: true,
      engagement: {
        token: 'strict-token-absolute-src',
        folder: '/workspace/project-phalanx/src',
        principalId: null,
      },
      targets: [{ kind: 'file', path: 'src/provider.ts' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.data.results[0]).toMatchObject({
      kind: 'raw_file',
      path: 'src/provider.ts',
    });
  });

  it.each([
    ['env file', '.env', enc('TOKEN=secret\n')],
    ['log file', 'logs/runtime.log', enc('stack trace\n')],
    ['binary extension', 'assets/logo.png', new Uint8Array([137, 80, 78, 71])],
    ['binary content', 'tests/fixtures/blob.txt', new Uint8Array([0, 1, 2])],
    ['invalid UTF-8 text', 'docs/invalid.md', new Uint8Array([0xc3, 0x28])],
    ['unlisted text', 'notes/random.txt', enc('plain text\n')],
  ])('fails closed for %s reads', async (_label, path, content) => {
    const { deps, fs } = makeStack();
    await fs.write(path, content);
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path }],
    }));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('UNSUPPORTED_TARGET');
    expect('data' in env).toBe(false);
    expect(env.provenance?.primitivesUsed).toEqual([]);
  });

  it('skips invalid UTF-8 files during strict text search without raw fallback', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/good.md', enc('needle-t114\n'));
    await fs.write(
      'docs/invalid.md',
      new Uint8Array([0x6e, 0x65, 0x65, 0x64, 0x6c, 0x65, 0xc3, 0x28]),
    );
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{ kind: 'pattern', regex: 'needle-t114', scope: ['docs'] }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.matches.map((m) => m.path)).toEqual(['docs/good.md']);
  });

  it('searches explicitly scoped root project docs', async () => {
    const { deps, fs } = makeStack();
    await fs.write('PHALANX_VISION.md', enc('Governance & Trust\n'));
    await fs.write('ARCHITECTURE_CHANGELOG.md', enc('provenance trail\n'));
    await fs.write('docs/PHALANX_ROADMAP.md', enc('audit lane\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'inspect_docs_or_config',
      targets: [{
        kind: 'pattern',
        regex: 'Governance & Trust|audit|provenance',
        scope: [
          'docs/PHALANX_ROADMAP.md',
          'PHALANX_VISION.md',
          'ARCHITECTURE_CHANGELOG.md',
        ],
      }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.matches.map((m) => m.path).sort()).toEqual([
      'ARCHITECTURE_CHANGELOG.md',
      'PHALANX_VISION.md',
      'docs/PHALANX_ROADMAP.md',
    ]);
  });

  it('fails closed for explicit strict search scope to env files', async () => {
    const { deps, fs } = makeStack();
    await fs.write('.env', enc('TOKEN=needle-t098\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{ kind: 'pattern', regex: 'needle-t098', scope: ['.env'] }],
    }));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('UNSUPPORTED_TARGET');
    expect('data' in env).toBe(false);
  });

  it('fails closed when an approved file class is outside the engagement folder', async () => {
    const { deps, fs } = makeStack();
    await fs.write('package.json', enc('{ "name": "root-package" }\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'package.json' }],
      engagement: SRC_ENGAGEMENT,
    }));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('UNSUPPORTED_TARGET');
    expect('data' in env).toBe(false);
  });
});
