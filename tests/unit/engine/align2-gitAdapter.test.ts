/**
 * ALIGN-2 tests — gitAdapter deprecated alias on HoplonAdapters.
 *
 * Proof requirements:
 *   1. versioning-only → normal flow (no deprecation event)
 *   2. gitAdapter-only → normalized to versioning, deprecation event emitted
 *   3. both provided → ValidationError({ kind: 'conflicting_adapters' })
 *
 * H13: deprecation event is structure-only (op: 'factory', errorKind: 'deprecated_adapter_gitAdapter').
 * H18: shipped names stay canonical; gitAdapter is the alias.
 */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

import { createHoplonEngine } from '../../../src/hoplon/engine/factory.js';
import { ValidationError } from '../../../src/hoplon/contracts/errors.js';
import type { HoplonAdapters } from '../../../src/hoplon/engine/types.js';
import { createMemFsAdapter } from '../../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createAsyncMutexLockProvider } from '../../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemoryEmitter } from '../../../src/hoplon/adapters/emitter/memory.js';
import { createBuiltinRegexScanner } from '../../../src/hoplon/adapters/secretScanner/builtin.js';
import { createTreeSitterIntelligence } from '../../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../../src/hoplon/adapters/codeIntelligence.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

const BASE_CONFIG = { engineId: 'align2-test', fsRoot: '/' };

async function makeBaseAdapters() {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();
  const versioning = createIsomorphicGitVersioning({ fs });

  return {
    fs,
    emitter,
    store,
    versioning,
    base: {
      fs,
      snapshotStore: store,
      lockProvider: createAsyncMutexLockProvider(),
      emitter,
      codeIntelligence: sharedCI,
      secretScanner: createBuiltinRegexScanner(),
    } as Omit<HoplonAdapters, 'versioning'>,
  };
}

// ---------------------------------------------------------------------------
// Test 1: versioning-only → normal flow, no deprecation event
// ---------------------------------------------------------------------------

describe('ALIGN-2 Test 1 — versioning-only: normal flow, no deprecation event', () => {
  it('constructs engine successfully with versioning only', async () => {
    const { base, versioning } = await makeBaseAdapters();
    const adapters: HoplonAdapters = { ...base, versioning };
    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
  });

  it('emits no factory deprecation event when versioning is used', async () => {
    const { base, versioning, emitter } = await makeBaseAdapters();
    const adapters: HoplonAdapters = { ...base, versioning };
    await createHoplonEngine(adapters, BASE_CONFIG);
    const factoryEvents = emitter.getEvents().filter(
      (e) => e.op === 'factory' && e.errorKind === 'deprecated_adapter_gitAdapter',
    );
    expect(factoryEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Test 2: gitAdapter-only → normalized to versioning, deprecation event emitted
// ---------------------------------------------------------------------------

describe('ALIGN-2 Test 2 — gitAdapter-only: normalized, deprecation event emitted', () => {
  it('constructs engine successfully when only gitAdapter is provided', async () => {
    const { base, versioning, emitter } = await makeBaseAdapters();
    // Provide gitAdapter instead of versioning; versioning is absent
    const adapters = {
      ...base,
      gitAdapter: versioning,
      // versioning is intentionally omitted
    } as unknown as HoplonAdapters;

    await expect(createHoplonEngine(adapters, BASE_CONFIG)).resolves.toBeDefined();
    void emitter; // used for next test
  });

  it('emits factory deprecation event with correct structure (H13)', async () => {
    const { base, versioning, emitter } = await makeBaseAdapters();
    const adapters = {
      ...base,
      gitAdapter: versioning,
    } as unknown as HoplonAdapters;

    await createHoplonEngine(adapters, BASE_CONFIG);

    const deprecationEvents = emitter.getEvents().filter(
      (e) => e.op === 'factory' && e.errorKind === 'deprecated_adapter_gitAdapter',
    );

    expect(deprecationEvents).toHaveLength(1);
    const evt = deprecationEvents[0]!;
    // H13: structure-only — op, phase, engineId, correlationId, errorCategory, errorKind
    expect(evt.op).toBe('factory');
    expect(evt.phase).toBe('error');
    expect(evt.engineId).toBe('align2-test');
    expect(evt.correlationId).toBe('factory');
    expect(evt.errorCategory).toBe('validation');
    expect(evt.errorKind).toBe('deprecated_adapter_gitAdapter');
  });

  it('engine constructed via gitAdapter works as if versioning was provided', async () => {
    const { base, versioning } = await makeBaseAdapters();
    const adapters = {
      ...base,
      gitAdapter: versioning,
    } as unknown as HoplonAdapters;

    const engine = await createHoplonEngine(adapters, BASE_CONFIG);
    // health() should report versioning adapter as ok (not missing or failed)
    const h = await engine.health();
    expect(h.adapters.versioning).toBe('ok');
  });
});

// ---------------------------------------------------------------------------
// Test 3: both versioning + gitAdapter → ValidationError({ kind: 'conflicting_adapters' })
// ---------------------------------------------------------------------------

describe('ALIGN-2 Test 3 — both versioning + gitAdapter: ValidationError', () => {
  it('throws ValidationError conflicting_adapters when both are provided', async () => {
    const { base, versioning } = await makeBaseAdapters();
    const adapters = {
      ...base,
      versioning,
      gitAdapter: versioning, // conflict: both present
    } as unknown as HoplonAdapters;

    await expect(createHoplonEngine(adapters, BASE_CONFIG)).rejects.toBeInstanceOf(
      ValidationError,
    );
  });

  it('ValidationError has kind conflicting_adapters', async () => {
    const { base, versioning } = await makeBaseAdapters();
    const adapters = {
      ...base,
      versioning,
      gitAdapter: versioning,
    } as unknown as HoplonAdapters;

    const err = await createHoplonEngine(adapters, BASE_CONFIG).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('conflicting_adapters');
    expect((err as ValidationError).correlationId).toBe('factory');
  });

  it('ValidationError is thrown before any adapter validation or emitter call', async () => {
    const { base, versioning, emitter } = await makeBaseAdapters();
    const adapters = {
      ...base,
      versioning,
      gitAdapter: versioning,
    } as unknown as HoplonAdapters;

    await expect(createHoplonEngine(adapters, BASE_CONFIG)).rejects.toBeInstanceOf(
      ValidationError,
    );
    // No factory events should have been emitted (error happens before emitter is used)
    const factoryEvents = emitter.getEvents().filter((e) => e.op === 'factory');
    expect(factoryEvents).toHaveLength(0);
  });
});
