import { beforeAll, describe, expect, it } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { seeCodebase, type SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';
import { packContext, type PackContextDeps } from '../../src/hoplon/operations/packContext.js';
import {
  extractStructuralTemplate,
  type ExtractStructuralTemplateDeps,
} from '../../src/hoplon/operations/extractStructuralTemplate.js';
import { queryStructure, type QueryStructureDeps } from '../../src/hoplon/operations/queryStructure.js';
import { searchSymbols, type SearchSymbolsDeps } from '../../src/hoplon/operations/searchSymbols.js';
import {
  describeProject,
  type DescribeProjectDeps,
} from '../../src/hoplon/operations/describeProject.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

describe('filesystem and text-model adversarial corpus (t-114)', () => {
  it('raw exact-text reads preserve BOM and CRLF bytes as text', async () => {
    const { deps, fs } = makeStack();
    const content = '\ufefffirst\r\nneedle-t114\r\nthird\r\n';
    await fs.write('docs/crlf.md', enc(content));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'docs/crlf.md' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.content).toBe(content);
    expect(raw.bytes).toBe(enc(content).length);
  });

  it('raw text search reports CRLF line numbers honestly', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/crlf-search.md', enc('one\r\ntwo\r\nneedle-t114\r\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{ kind: 'pattern', regex: 'needle-t114' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.matches).toHaveLength(1);
    expect(search.matches[0]?.line).toBe(3);
    expect(search.matches[0]?.text).toBe('needle-t114\r');
  });
});

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-t114',
    runId: 'run-t114-001',
    correlationId: 'corr-t114-001',
    ...overrides,
  };
}

function makeStack(): {
  deps: SeeCodebaseDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const root = '/';
  const config = { maxFileBytes: 524288, parseTimeoutMs: 5000 };
  const engineId = 'test-engine';
  const common = { fs, codeIntelligence: sharedCI, emitter, engineId, root, config };
  return {
    fs,
    deps: {
      fs,
      emitter,
      engineId,
      root,
      config,
      packContext: (req, signal) =>
        packContext(common as PackContextDeps, req, signal),
      extractStructuralTemplate: (req, signal) =>
        extractStructuralTemplate(common as ExtractStructuralTemplateDeps, req, signal),
      queryStructure: (req, signal) =>
        queryStructure(common as QueryStructureDeps, req, signal),
      searchSymbols: (req, signal) =>
        searchSymbols(common as SearchSymbolsDeps, req, signal),
      describeProject: (req, signal) =>
        describeProject(common as DescribeProjectDeps, req, signal),
    },
  };
}
