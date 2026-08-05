/**
 * tests/operations/ephemeralStructuralSandbox.test.ts - t-108 proof.
 *
 * Proves the sandbox parses synthetic snippets in memory, returns
 * parse/structure-only results by default, explicitly degrades type/provider
 * checks, and does not touch project-state adapters through the engine facade.
 */

import { beforeAll, describe, expect, it, vi } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { LockProvider } from '../../src/hoplon/adapters/lock.js';
import type { SecretScannerAdapter } from '../../src/hoplon/adapters/secretScanner.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { VersioningAdapter } from '../../src/hoplon/adapters/versioning.js';
import { createHoplonEngine } from '../../src/hoplon/engine/factory.js';
import {
  ephemeralStructuralSandbox,
  type EphemeralStructuralSandboxDeps,
} from '../../src/hoplon/operations/ephemeralStructuralSandbox.js';
import {
  EphemeralStructuralSandboxResultSchema,
  type EphemeralStructuralSandboxRequest,
} from '../../src/hoplon/contracts/structuralSandbox.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');
const CORR = 'corr-sandbox-001';

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeDeps(): {
  deps: EphemeralStructuralSandboxDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const emitter = createMemoryEmitter();
  return {
    deps: {
      codeIntelligence: sharedCI,
      emitter,
      engineId: 'engine-sandbox-test',
      config: { parseTimeoutMs: 5000 },
    },
    emitter,
  };
}

function makeReq(
  overrides: Partial<EphemeralStructuralSandboxRequest> = {},
): EphemeralStructuralSandboxRequest {
  return {
    correlationId: CORR,
    projectId: 'proj-sandbox',
    runId: 'run-sandbox',
    snippets: [
      {
        id: 'snippet-1',
        path: 'synthetic/planning',
        language: 'typescript',
        content:
          'export function add(a: number, b: number): number { return a + b; }',
        expectations: {
          rootKind: 'program',
          requiredNodeKinds: ['function_declaration'],
          requiredTopLevelSymbols: ['add'],
        },
      },
    ],
    ...overrides,
  };
}

describe('ephemeralStructuralSandbox', () => {
  it('parses synthetic snippets in memory and reports structure compatibility', async () => {
    const { deps, emitter } = makeDeps();
    const result = await ephemeralStructuralSandbox(deps, makeReq());

    expect(EphemeralStructuralSandboxResultSchema.safeParse(result).success).toBe(true);
    expect(result.advisory).toBe(true);
    expect(result.status).toBe('PARSE_AND_STRUCTURE_OK');
    expect(result.checked).toBe(1);
    expect(result.typeProvider.status).toBe('NOT_REQUESTED');
    expect(result.typeProvider.compilerProof).toBe(false);
    expect(result.sideEffectProfile).toMatchObject({
      inMemoryOnly: true,
      usesFilesystem: false,
      usesVersioning: false,
      usesSnapshotStore: false,
      usesAuditLog: false,
      usesSessionMutation: false,
      usesLocks: false,
    });
    expect(result.nonBypass.doesNotReplace).toEqual([
      'dryRun',
      'auditDiff',
      'policy',
      'session_apply_edits',
    ]);
    expect(result.snippets[0]?.structure.topLevelSymbols[0]?.name).toBe('add');
    for (const event of emitter.getEvents()) assertEventIsContentFree(event);
  });

  it('reports syntax error nodes as structure issues rather than compiler proof', async () => {
    const { deps } = makeDeps();
    const result = await ephemeralStructuralSandbox(
      deps,
      makeReq({
        snippets: [
          {
            id: 'broken',
            path: 'synthetic/broken',
            language: 'typescript',
            content: 'export function broken(',
          },
        ],
      }),
    );

    expect(result.status).toBe('PARSE_OR_STRUCTURE_ISSUES');
    expect(result.snippets[0]?.status).toBe('STRUCTURE_ISSUES');
    expect(result.snippets[0]?.parse.status).toBe('OK');
    expect(result.snippets[0]?.structure.errorNodeCount).toBeGreaterThan(0);
    expect(result.typeProvider.compilerProof).toBe(false);
  });

  it('returns parse failures for unsupported synthetic paths without reading files', async () => {
    const { deps } = makeDeps();
    const result = await ephemeralStructuralSandbox(
      deps,
      makeReq({
        snippets: [
          {
            id: 'unsupported',
            path: 'synthetic/snippet.unknown',
            content: 'export const x = 1;',
          },
        ],
      }),
    );

    expect(result.status).toBe('PARSE_OR_STRUCTURE_ISSUES');
    expect(result.snippets[0]?.status).toBe('PARSE_FAILED');
    expect(result.snippets[0]?.structure.status).toBe('UNAVAILABLE');
  });

  it('marks requested type/provider checks unavailable when no in-memory provider exists', async () => {
    const { deps } = makeDeps();
    const result = await ephemeralStructuralSandbox(
      deps,
      makeReq({ options: { includeTypeProviderCheck: true } }),
    );

    expect(result.typeProvider).toEqual({
      status: 'UNAVAILABLE',
      providerId: null,
      reason: 'no_in_memory_type_provider',
      compilerProof: false,
    });
  });

  it('rejects invalid requests with ValidationError', async () => {
    const { deps } = makeDeps();
    await expect(
      ephemeralStructuralSandbox(deps, { correlationId: CORR, snippets: [] } as unknown as EphemeralStructuralSandboxRequest),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('does not touch fs, versioning, snapshot, audit, lock, or secret adapters from the engine facade', async () => {
    const fs = failingAdapter<HoplonFsAdapter>(['read', 'write', 'list', 'stat', 'mkdir', 'remove']);
    const versioning = failingAdapter<VersioningAdapter>([
      'init', 'add', 'remove', 'commit', 'checkout', 'statusMatrix', 'resolveRef',
      'push', 'fetch', 'readBlob', 'diffSnapshotFiles', 'readCommitInfo',
    ]);
    const snapshotStore = failingAdapter<SnapshotStore>([
      'put', 'get', 'findByProjectAndRun', 'updateStatus', 'gc',
      'appendAuditLog', 'findAuditLogByProjectAndRun', 'gcAuditLog',
      'findPolicyAuditEntries',
    ], { listPending: vi.fn(async () => []) });
    const lockProvider = failingAdapter<LockProvider>(['acquire']);
    const secretScanner = failingAdapter<SecretScannerAdapter>(['scan']);
    const emitter = createMemoryEmitter();

    const engine = await createHoplonEngine(
      {
        fs,
        versioning,
        snapshotStore,
        lockProvider,
        emitter,
        codeIntelligence: sharedCI,
        secretScanner,
      },
      { engineId: 'engine-sandbox-facade', fsRoot: '/', parseTimeoutMs: 5000 },
    );
    clearAdapterMocks(snapshotStore);
    emitter.clear();

    const result = await engine.ephemeralStructuralSandbox(makeReq());
    expect(result.status).toBe('PARSE_AND_STRUCTURE_OK');

    expectAdapterUnused(fs);
    expectAdapterUnused(versioning);
    expectAdapterUnused(snapshotStore);
    expectAdapterUnused(lockProvider);
    expectAdapterUnused(secretScanner);
  });
});

function failingAdapter<T extends object>(
  methods: readonly string[],
  overrides: Record<string, unknown> = {},
): T {
  const adapter: Record<string, unknown> = { ...overrides };
  for (const method of methods) {
    adapter[method] = vi.fn(async () => {
      throw new Error(`${method} should not be called by ephemeralStructuralSandbox`);
    });
  }
  return adapter as T;
}

function clearAdapterMocks(adapter: object): void {
  for (const value of Object.values(adapter)) {
    if (typeof value === 'function' && 'mockClear' in value) {
      (value as { mockClear: () => void }).mockClear();
    }
  }
}

function expectAdapterUnused(adapter: object): void {
  for (const value of Object.values(adapter)) {
    if (typeof value === 'function' && 'mock' in value) {
      expect(value).not.toHaveBeenCalled();
    }
  }
}
