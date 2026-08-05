/**
 * tests/operations/seeCodebase.test.ts — t-061 targeted proof.
 *
 * Slice-scoped coverage for the unified read/search macro:
 *  SC-1  raw file read through Hoplon returns verbatim content for a non-JS file.
 *  SC-2  raw text search through Hoplon finds matches in docs / non-JS files.
 *  SC-3  structural route reuses existing primitives (searchSymbols) under
 *        see_codebase for find_symbol intent on JS/TS.
 *  SC-4  mode: skeleton routes to extractStructuralTemplate — no parallel path.
 *  SC-5  strict: true blocks silent fallback (structural on unsupported grammar)
 *        and returns STRICT_BLOCKED_FALLBACK with requested+suggested labels.
 *  SC-6  Envelope provenance records selectedPath, routingReason,
 *        primitivesUsed, fallback flags, and latency/bytes metrics.
 *  SC-7  Exact-text intent inside a .ts file is routed raw (not structural).
 *  SC-8  Mixed supported/unsupported file targets use structural+raw instead
 *        of silently dropping the unsupported target.
 *  SC-9  find_symbol on an unsupported file falls back to raw search rather
 *        than returning an empty structural success.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

import { seeCodebase } from '../../src/hoplon/operations/seeCodebase.js';
import type { SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';
import { packContext } from '../../src/hoplon/operations/packContext.js';
import type { PackContextDeps } from '../../src/hoplon/operations/packContext.js';
import { extractStructuralTemplate } from '../../src/hoplon/operations/extractStructuralTemplate.js';
import type { ExtractStructuralTemplateDeps } from '../../src/hoplon/operations/extractStructuralTemplate.js';
import { queryStructure } from '../../src/hoplon/operations/queryStructure.js';
import type { QueryStructureDeps } from '../../src/hoplon/operations/queryStructure.js';
import { searchSymbols } from '../../src/hoplon/operations/searchSymbols.js';
import type { SearchSymbolsDeps } from '../../src/hoplon/operations/searchSymbols.js';
import { describeProject } from '../../src/hoplon/operations/describeProject.js';
import type { DescribeProjectDeps } from '../../src/hoplon/operations/describeProject.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';

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

function makeStack(): {
  deps: SeeCodebaseDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const root = '/';
  const config = { maxFileBytes: 524288, parseTimeoutMs: 5000 };
  const engineId = 'test-engine';
  const packCtxDeps: PackContextDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  } as PackContextDeps;
  const qsDeps: QueryStructureDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  };
  const estDeps: ExtractStructuralTemplateDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  } as ExtractStructuralTemplateDeps;
  const ssDeps: SearchSymbolsDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  };
  const dpDeps: DescribeProjectDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter,
    engineId,
    root,
    config,
  } as DescribeProjectDeps;
  const deps: SeeCodebaseDeps = {
    fs,
    emitter,
    engineId,
    root,
    config,
    packContext: (req, signal) => packContext(packCtxDeps, req, signal),
    extractStructuralTemplate: (req, signal) =>
      extractStructuralTemplate(estDeps, req, signal),
    queryStructure: (req, signal) => queryStructure(qsDeps, req, signal),
    searchSymbols: (req, signal) => searchSymbols(ssDeps, req, signal),
    describeProject: (req, signal) => describeProject(dpDeps, req, signal),
  };
  return { deps, fs, emitter };
}

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-sc',
    runId: 'run-sc-001',
    correlationId: 'corr-sc-001',
    ...overrides,
  };
}

describe('seeCodebase', () => {
  it('SC-1: raw file read returns verbatim content for a non-JS file', async () => {
    const { deps, fs } = makeStack();
    await fs.write('README.md', enc('# Hoplon\n\nraw text lives here.\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'README.md' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.data.results).toHaveLength(1);
    const r = env.data.results[0];
    if (!r || r.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(r.content).toContain('raw text lives here');
    expect(r.path).toBe('README.md');
    expect(r.truncated).toBe(false);
    expect(env.provenance?.selectedPath).toBe('raw');
    expect(env.provenance?.primitivesUsed).toContain('rawFileRead');
  });

  it('SC-2: raw text search finds matches in docs / non-JS sources', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/guide.md', enc('alpha\nbeta\nneedle-here\n'));
    await fs.write('config/app.yaml', enc('service: needle-here\n'));
    await fs.write('src/sample.ts', enc('export const x = 1;\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{ kind: 'pattern', regex: 'needle-here' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    const paths = search.matches.map((m) => m.path).sort();
    expect(paths).toContain('config/app.yaml');
    expect(paths).toContain('docs/guide.md');
    expect(env.provenance?.primitivesUsed).toContain('rawTextSearch');
    expect(env.provenance?.selectedPath).toBe('raw');
  });

  it('SC-3: structural route reuses searchSymbols under find_symbol intent', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/svc.ts', enc('export function createFoo(){}\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.provenance?.selectedPath).toBe('structural');
    expect(env.provenance?.primitivesUsed).toContain('searchSymbols');
    const structural = env.data.results.find((r) => r.kind === 'structural');
    expect(structural).toBeDefined();
  });

  it('SC-4: mode:skeleton routes to extractStructuralTemplate (no parallel engine)', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/svc.ts', enc('export const a = 1;\nexport function f(){}\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{ kind: 'file', path: 'src/svc.ts' }],
      mode: 'skeleton',
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.provenance?.selectedPath).toBe('skeleton');
    expect(env.provenance?.primitivesUsed).toEqual(['extractStructuralTemplate']);
    const sk = env.data.results.find((r) => r.kind === 'skeleton');
    expect(sk).toBeDefined();
  });

  it('SC-5: strict:true blocks structural→raw fallback on unsupported grammar', async () => {
    const { deps, fs } = makeStack();
    await fs.write('notes.md', enc('no code here'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{ kind: 'file', path: 'notes.md' }],
      strict: true,
    }));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('STRICT_BLOCKED_FALLBACK');
    expect(env.error.requestedPath).toBe('structural');
    expect(env.error.suggestedPath).toBe('raw');
    expect(env.provenance?.fallbackBlockedByStrict).toBe(true);
  });

  it('SC-6: provenance envelope reports all required routing fields', async () => {
    const { deps, fs } = makeStack();
    await fs.write('file.txt', enc('content\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'file.txt' }],
    }));
    expect(env.ok).toBe(true);
    const p = env.provenance;
    expect(p).toBeDefined();
    if (!p) throw new Error('unreachable');
    expect(p.selectedPath).toBe('raw');
    expect(p.routingReason.length).toBeGreaterThan(0);
    expect(p.routingFactors.intent).toBe('read_exact_text');
    expect(p.routingFactors.modeRequested).toBe('auto');
    expect(p.routingFactors.strict).toBe(false);
    expect(p.primitivesUsed).toContain('rawFileRead');
    expect(p.fallbackOccurred).toBe(false);
    expect(p.fallbackBlockedByStrict).toBe(false);
    expect(typeof p.metrics.latencyMs).toBe('number');
    expect(p.metrics.bytesReturned).toBeGreaterThan(0);
    expect(p.correlationId).toBe('corr-sc-001');
    expect(p.engineId).toBe('test-engine');
  });

  it('SC-7: exact-text intent routes raw even inside a .ts file', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/svc.ts', enc('// copyright XYZ\nexport const x = 1;\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'src/svc.ts' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.provenance?.selectedPath).toBe('raw');
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.content).toContain('copyright XYZ');
  });

  it('SC-8: mixed file targets use structural+raw and keep unsupported files visible', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/svc.ts', enc('export function createFoo(){}\n'));
    await fs.write('docs/notes.md', enc('shape notes stay raw\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [
        { kind: 'file', path: 'src/svc.ts' },
        { kind: 'file', path: 'docs/notes.md' },
      ],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.provenance?.selectedPath).toBe('structural+raw');
    expect(env.provenance?.fallbackOccurred).toBe(true);
    expect(env.provenance?.primitivesUsed).toContain('packContext');
    expect(env.provenance?.primitivesUsed).toContain('rawFileRead');
    const raw = env.data.results.find((r) => r.kind === 'raw_file');
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.path).toBe('docs/notes.md');
  });

  it('SC-9: find_symbol on unsupported file falls back to raw search', async () => {
    const { deps, fs } = makeStack();
    await fs.write('notes.md', enc('todo: createFoo is mentioned here\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'find_symbol',
      targets: [{ kind: 'symbol', name: 'createFoo', file: 'notes.md' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.provenance?.selectedPath).toBe('raw');
    expect(env.provenance?.fallbackOccurred).toBe(true);
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(raw.matches.map((m) => m.path)).toContain('notes.md');
  });

  // t-075: the packaged seeCodebase surface is authoritative for supported
  // non-binary code reads/searches. The proofs below previously would have
  // required host `cat` / `rg` because non-JS/TS code files (e.g. .py, .go,
  // .rs) had no structural grammar; after t-075 they run through
  // engine.seeCodebase via the rawFileRead / rawTextSearch primitives on
  // the same packaged surface. MemFS guarantees no real host filesystem
  // is touched.
  it('SC-11 (t-075): exact-text read of a non-JS/TS code file runs through seeCodebase', async () => {
    const { deps, fs } = makeStack();
    await fs.write(
      'service/api.py',
      enc(
        '# copyright 2026 ACME\n' +
          'def create_user(name: str) -> None:\n' +
          '    """Create a user."""\n' +
          '    api_key = "secret-marker"\n' +
          '    return None\n',
      ),
    );
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'service/api.py' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    // verbatim comment, docstring, and string literal all preserved
    expect(raw.content).toContain('# copyright 2026 ACME');
    expect(raw.content).toContain('"""Create a user."""');
    expect(raw.content).toContain('secret-marker');
    expect(raw.path).toBe('service/api.py');
    expect(env.provenance?.selectedPath).toBe('raw');
    expect(env.provenance?.primitivesUsed).toEqual(['rawFileRead']);
  });

  it('SC-12 (t-075): raw text search over multi-language code scope runs through seeCodebase', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/api.ts', enc('// marker: hoplon-t075 code-adjacent\n'));
    await fs.write('service/api.py', enc('# marker: hoplon-t075 code-adjacent\n'));
    await fs.write('cmd/tool.go', enc('// marker: hoplon-t075 code-adjacent\n'));
    await fs.write('crates/lib/lib.rs', enc('// marker: hoplon-t075 code-adjacent\n'));
    // non-code repo text that MUST NOT appear in the code-boundary scope
    await fs.write('docs/notes.md', enc('marker: hoplon-t075 lives in docs too\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{
        kind: 'pattern',
        regex: 'hoplon-t075',
        scope: ['src', 'service', 'cmd', 'crates'],
      }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    const paths = search.matches.map((m) => m.path).sort();
    expect(paths).toEqual([
      'cmd/tool.go',
      'crates/lib/lib.rs',
      'service/api.py',
      'src/api.ts',
    ]);
    // docs/notes.md is intentionally out of scope; the code boundary must
    // not silently include it.
    expect(paths).not.toContain('docs/notes.md');
    expect(env.provenance?.primitivesUsed).toContain('rawTextSearch');
  });

  // ---------------------------------------------------------------------------
  // t-078 proofs — per-result `readProvenance` metadata
  //
  // DoD: supported non-binary code reads report honest content provenance on
  // the existing seeCodebase envelope; unsupported routes surface provenance
  // honestly instead of fabricating it.
  // ---------------------------------------------------------------------------
  it('SC-14 (t-078): raw_file results carry live_filesystem readProvenance with workspaceRoot + filePath', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/readme.md', enc('# t-078\n'));
    const before = Date.now();
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'docs/readme.md' }],
    }));
    const after = Date.now();
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.readProvenance.kind).toBe('live_filesystem');
    if (raw.readProvenance.kind !== 'live_filesystem') throw new Error('unreachable');
    expect(raw.readProvenance.workspaceRoot).toBe('/');
    expect(raw.readProvenance.filePath).toBe('docs/readme.md');
    // readAtIso is ISO 8601 UTC and within the observed window.
    const readMs = Date.parse(raw.readProvenance.readAtIso);
    expect(Number.isFinite(readMs)).toBe(true);
    expect(readMs).toBeGreaterThanOrEqual(before);
    expect(readMs).toBeLessThanOrEqual(after);
  });

  it('SC-15 (t-078): raw_search results carry live_filesystem readProvenance without a single filePath', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/a.md', enc('marker\n'));
    await fs.write('docs/b.md', enc('marker\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'search_exact_text',
      targets: [{ kind: 'pattern', regex: 'marker' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results.find((r) => r.kind === 'raw_search');
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.readProvenance.kind).toBe('live_filesystem');
    if (search.readProvenance.kind !== 'live_filesystem') throw new Error('unreachable');
    expect(search.readProvenance.workspaceRoot).toBe('/');
    // Multi-file scan: `filePath` is explicitly absent (honest — not fabricated).
    expect('filePath' in search.readProvenance).toBe(false);
  });

  it('SC-16 (t-078): structural packContext result carries live_filesystem readProvenance with the scoped filePath', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/svc.ts', enc('export const a = 1;\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{ kind: 'file', path: 'src/svc.ts' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const structural = env.data.results.find((r) => r.kind === 'structural');
    if (!structural || structural.kind !== 'structural') throw new Error('expected structural');
    expect(structural.primitive).toBe('packContext');
    expect(structural.readProvenance.kind).toBe('live_filesystem');
    if (structural.readProvenance.kind !== 'live_filesystem') throw new Error('unreachable');
    expect(structural.readProvenance.workspaceRoot).toBe('/');
    expect(structural.readProvenance.filePath).toBe('src/svc.ts');
  });

  it('SC-17 (t-078): strict-blocked fallback surfaces no read results (unsupported route is honest, not fabricated)', async () => {
    const { deps, fs } = makeStack();
    await fs.write('notes.md', enc('no code\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{ kind: 'file', path: 'notes.md' }],
      strict: true,
    }));
    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    // The error envelope never carries fabricated per-result provenance — it
    // has no `data.results` field. The envelope-level `provenance` reports the
    // blocked-fallback reason instead.
    expect('data' in env).toBe(false);
    expect(env.error.kind).toBe('STRICT_BLOCKED_FALLBACK');
    expect(env.provenance?.fallbackBlockedByStrict).toBe(true);
  });

  it('SC-18 (t-078): skeleton path carries live_filesystem readProvenance for single-file targets', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/skel.ts', enc('export const a = 1;\nexport function f(){}\n'));
    const env = await seeCodebase(deps, makeReq({
      intent: 'understand_code_shape',
      targets: [{ kind: 'file', path: 'src/skel.ts' }],
      mode: 'skeleton',
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const sk = env.data.results.find((r) => r.kind === 'skeleton');
    if (!sk || sk.kind !== 'skeleton') throw new Error('expected skeleton');
    expect(sk.readProvenance.kind).toBe('live_filesystem');
    if (sk.readProvenance.kind !== 'live_filesystem') throw new Error('unreachable');
    expect(sk.readProvenance.workspaceRoot).toBe('/');
    expect(sk.readProvenance.filePath).toBe('src/skel.ts');
  });

  it('SC-13 (t-075): exact-text read of a Go source file preserves code-adjacent raw text', async () => {
    const { deps, fs } = makeStack();
    await fs.write(
      'cmd/cli.go',
      enc(
        '// Copyright 2026 Hoplon contributors.\n' +
          'package main\n\n' +
          'import "fmt"\n\n' +
          'func main() {\n' +
          '\t// TODO(hoplon-t075): wire the client\n' +
          '\tfmt.Println("hello-t075")\n' +
          '}\n',
      ),
    );
    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'cmd/cli.go' }],
    }));
    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.content).toContain('Copyright 2026 Hoplon contributors.');
    expect(raw.content).toContain('TODO(hoplon-t075): wire the client');
    expect(raw.content).toContain('hello-t075');
    expect(env.provenance?.selectedPath).toBe('raw');
    expect(env.provenance?.primitivesUsed).toEqual(['rawFileRead']);
  });

  it('wf-loop-001: edit_slice returns exact bounded text with edit anchors', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/edit.ts', enc('line one\nline two\nline three\n'));

    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{
        kind: 'edit_slice',
        path: 'src/edit.ts',
        startLine: 2,
        endLine: 3,
      }],
    }));

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const slice = env.data.results[0];
    if (!slice || slice.kind !== 'edit_slice') throw new Error('expected edit_slice');
    expect(slice.content).toBe('line two\nline three\n');
    expect(slice.omitted).toBe(false);
    expect(slice.safeToEditFrom).toBe(true);
    expect(slice.encoding).toBe('utf-8');
    expect(slice.newlineStyle).toBe('lf');
    expect(slice.anchors.contentSha256).toMatch(/^sha256:/u);
    expect(slice.tokenTelemetry?.estimatedTokensSaved).toBeGreaterThan(0);
    expect(env.provenance?.primitivesUsed).toEqual(['editSliceRead']);
    expect(env.provenance?.metrics.tokenTelemetry?.rawBytesConsidered).toBeGreaterThan(
      env.provenance?.metrics.bytesReturned ?? 0,
    );
  });

  it('wf-loop-001: edit_slice refuses unavailable exact text explicitly', async () => {
    const { deps, fs } = makeStack();
    await fs.write('src/edit.ts', enc('line one\n'));

    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      targets: [{
        kind: 'edit_slice',
        path: 'src/edit.ts',
        startLine: 20,
        endLine: 21,
      }],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('INVALID_REQUEST');
    expect(env.error.message).toContain('edit_slice startLine is outside file');
  });

});
