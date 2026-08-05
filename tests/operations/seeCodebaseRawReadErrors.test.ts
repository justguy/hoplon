import { describe, expect, it } from 'vitest';

import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { SeeCodebaseEnvelopeSchema } from '../../src/hoplon/contracts/seeCodebase.js';
import { seeCodebase, type SeeCodebaseDeps } from '../../src/hoplon/operations/seeCodebase.js';

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

function makeStack(): {
  deps: SeeCodebaseDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
} {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const notExpected = async (): Promise<never> => {
    throw new Error('unexpected non-raw primitive');
  };
  return {
    fs,
    deps: {
      fs,
      emitter,
      engineId: 'test-engine',
      root: '/',
      config: { maxFileBytes: 524288, parseTimeoutMs: 5000 },
      packContext: notExpected,
      extractStructuralTemplate: notExpected,
      searchSymbols: notExpected,
      describeProject: notExpected,
    },
  };
}

function makeReq<T extends object>(overrides: T) {
  return {
    projectId: 'proj-raw-errors',
    runId: 'run-raw-errors-001',
    correlationId: 'corr-raw-errors-001',
    ...overrides,
  };
}

describe('seeCodebase raw read errors', () => {
  it('returns partial results with PATH_NOT_FOUND for a missing file in a raw batch', async () => {
    const { deps, fs } = makeStack();
    await fs.write(
      'ui/src/hooks/useGlobalTelemetry.ts',
      enc('export const telemetry = true;\n'),
    );

    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      mode: 'raw',
      targets: [
        { kind: 'file', path: 'ui/src/hooks/useGlobalTelemetry.ts' },
        { kind: 'file', path: 'ui/src/views/Dashboard.tsx' },
      ],
    }));

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.data.results).toHaveLength(1);
    const raw = env.data.results[0];
    if (!raw || raw.kind !== 'raw_file') throw new Error('expected raw_file');
    expect(raw.path).toBe('ui/src/hooks/useGlobalTelemetry.ts');
    expect(raw.content).toContain('telemetry = true');
    expect(env.data.partial).toBe(true);
    expect(env.data.errors).toHaveLength(1);
    expect(env.data.errors?.[0]).toMatchObject({
      kind: 'PATH_NOT_FOUND',
      requestedPath: 'raw',
      targetPath: 'ui/src/views/Dashboard.tsx',
    });
    expect(env.provenance?.selectedPath).toBe('raw');
    expect(SeeCodebaseEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('keeps all-fail missing-file batches as PATH_NOT_FOUND errors', async () => {
    const { deps } = makeStack();

    const env = await seeCodebase(deps, makeReq({
      intent: 'read_exact_text',
      mode: 'raw',
      targets: [{ kind: 'file', path: 'ui/src/views/Dashboard.tsx' }],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('PATH_NOT_FOUND');
    expect(env.error.requestedPath).toBe('raw');
    expect(env.error.targetPath).toBe('ui/src/views/Dashboard.tsx');
    expect('data' in env).toBe(false);
    expect(SeeCodebaseEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('returns partial results when a later target disappears between stat and read', async () => {
    const { deps, fs } = makeStack();
    await fs.write('ui/src/hooks/useGlobalTelemetry.ts', enc('export const ok = true;\n'));
    const targetPath = 'ui/src/views/Dashboard.tsx';
    const vanishingFs: HoplonFsAdapter = {
      ...fs,
      async stat(path) {
        if (path === targetPath) return { exists: true, isFile: true, size: 20 };
        return fs.stat(path);
      },
      async read(path) {
        if (path === targetPath) {
          throw Object.assign(new Error(`Failed to read '${path}'`), {
            kind: 'fs_read_failed',
            cause: { code: 'ENOENT' },
          });
        }
        return fs.read(path);
      },
    };

    const env = await seeCodebase({ ...deps, fs: vanishingFs }, makeReq({
      intent: 'read_exact_text',
      mode: 'raw',
      targets: [
        { kind: 'file', path: 'ui/src/hooks/useGlobalTelemetry.ts' },
        { kind: 'file', path: targetPath },
      ],
    }));

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    expect(env.data.results).toHaveLength(1);
    expect(env.data.partial).toBe(true);
    expect(env.data.errors?.[0]).toMatchObject({
      kind: 'PATH_NOT_FOUND',
      targetPath,
    });
  });

  it('returns partial results for mixed pattern success and unsupported file target', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/guide.md', enc('needle from docs\n'));

    const env = await seeCodebase(deps, makeReq({
      intent: 'mixed',
      mode: 'raw',
      engagement: { folder: '/', principalId: null, token: 'test-token' },
      targets: [
        { kind: 'pattern', regex: 'needle' },
        { kind: 'file', path: 'opaque' },
      ],
    }));

    expect(env.ok).toBe(true);
    if (!env.ok) throw new Error('unreachable');
    const search = env.data.results[0];
    if (!search || search.kind !== 'raw_search') throw new Error('expected raw_search');
    expect(search.matches.map((match) => match.path)).toContain('docs/guide.md');
    expect(env.data.partial).toBe(true);
    expect(env.data.errors?.[0]).toMatchObject({
      kind: 'UNSUPPORTED_TARGET',
      requestedPath: 'raw',
      targetPath: 'opaque',
    });
    expect(SeeCodebaseEnvelopeSchema.safeParse(env).success).toBe(true);
  });

  it('keeps invalid regex syntax as an all-request INVALID_REQUEST failure', async () => {
    const { deps, fs } = makeStack();
    await fs.write('docs/guide.md', enc('valid content\n'));

    const env = await seeCodebase(deps, makeReq({
      intent: 'mixed',
      mode: 'raw',
      targets: [
        { kind: 'file', path: 'docs/guide.md' },
        { kind: 'pattern', regex: '[' },
      ],
    }));

    expect(env.ok).toBe(false);
    if (env.ok) throw new Error('unreachable');
    expect(env.error.kind).toBe('INVALID_REQUEST');
    expect(env.error.message).toContain('pattern regex is invalid');
    expect('data' in env).toBe(false);
  });
});
