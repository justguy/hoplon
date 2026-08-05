/**
 * ALIGN-4 — engineId deprecation note when present on HoplonAdapters.
 *
 * Proof requirements (all 4 cases from the slice spec):
 *   A4-1  config.engineId set, adapters.engineId unset → normal flow, no deprecation event.
 *   A4-2  adapters.engineId set, config.engineId unset → deprecation event emitted
 *         (op:'factory', phase:'error', errorKind:'deprecated_adapter_engineId');
 *         effective engineId is taken from adapters.engineId.
 *   A4-3  Both set and identical → no deprecation event; proceed normally.
 *   A4-4  Both set and different → ValidationError({ kind: 'conflicting_adapters' }).
 *
 * These tests are intentionally minimal: they target factory.ts + types.ts only.
 * They do not test the full engine lifecycle beyond what is needed to confirm the
 * deprecation logic.
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

async function makeBaseAdapters(): Promise<{
  adapters: HoplonAdapters;
  emitter: ReturnType<typeof createMemoryEmitter>;
}> {
  const fs = createMemFsAdapter();
  const emitter = createMemoryEmitter();
  const store = await createIsolatedTestStore();

  const adapters: HoplonAdapters = {
    fs,
    versioning: createIsomorphicGitVersioning({ fs }),
    snapshotStore: store,
    lockProvider: createAsyncMutexLockProvider(),
    emitter,
    codeIntelligence: sharedCI,
    secretScanner: createBuiltinRegexScanner(),
  };

  return { adapters, emitter };
}

// ---------------------------------------------------------------------------
// A4-1: config.engineId set, adapters.engineId unset → normal flow, no warning
// ---------------------------------------------------------------------------

describe('ALIGN-4 A4-1 — config.engineId only: normal flow, no deprecation event', () => {
  it('engine constructs with config.engineId; no deprecated_adapter_engineId event emitted', async () => {
    const { adapters, emitter } = await makeBaseAdapters();

    const engine = await createHoplonEngine(adapters, {
      engineId: 'config-engine',
      fsRoot: '/',
    });

    // Engine should report the config-supplied engineId
    const h = await engine.health();
    expect(h.engineId).toBe('config-engine');

    // No deprecation event should have been emitted
    const deprecationEvents = emitter
      .getEvents()
      .filter((e) => e.errorKind === 'deprecated_adapter_engineId');
    expect(deprecationEvents).toHaveLength(0);
  });

  it('adapters.engineId is absent → no deprecation event, adapters.engineId is undefined', async () => {
    const { adapters, emitter } = await makeBaseAdapters();

    // Confirm adapters.engineId is not present
    expect(adapters.engineId).toBeUndefined();

    await createHoplonEngine(adapters, { engineId: 'my-engine', fsRoot: '/' });

    const deprecationEvents = emitter
      .getEvents()
      .filter((e) => e.errorKind === 'deprecated_adapter_engineId');
    expect(deprecationEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// A4-2: adapters.engineId set, config.engineId unset → deprecation event emitted;
//        effective engineId taken from adapters.engineId
// ---------------------------------------------------------------------------

describe('ALIGN-4 A4-2 — adapters.engineId only: deprecation event emitted', () => {
  it('emits deprecated_adapter_engineId event with correct structure (H13 compliant)', async () => {
    const { adapters, emitter } = await makeBaseAdapters();

    // Set engineId on adapters (deprecated location) only
    const deprecatedAdapters: HoplonAdapters = {
      ...adapters,
      engineId: 'adapters-engine',
    };

    // No config.engineId provided → should use adapters.engineId as effective engineId
    await createHoplonEngine(deprecatedAdapters, { fsRoot: '/' });

    // Verify deprecation event was emitted
    const deprecationEvents = emitter
      .getEvents()
      .filter((e) => e.errorKind === 'deprecated_adapter_engineId');
    expect(deprecationEvents).toHaveLength(1);

    const evt = deprecationEvents[0]!;
    // H13: content-free
    expect(evt.op).toBe('factory');
    expect(evt.phase).toBe('error');
    expect(evt.engineId).toBe('adapters-engine'); // effective engineId from adapters
    expect(evt.correlationId).toBe('factory');
    expect(evt.errorCategory).toBe('validation');
    expect(evt.errorKind).toBe('deprecated_adapter_engineId');
  });

  it('effective engineId is taken from adapters.engineId when config.engineId is absent', async () => {
    const { adapters } = await makeBaseAdapters();

    const deprecatedAdapters: HoplonAdapters = {
      ...adapters,
      engineId: 'from-adapters',
    };

    const engine = await createHoplonEngine(deprecatedAdapters, { fsRoot: '/' });

    const h = await engine.health();
    // Effective engineId must be the value from adapters (copied through)
    expect(h.engineId).toBe('from-adapters');
  });
});

// ---------------------------------------------------------------------------
// A4-3: both set and identical → no deprecation event; proceed normally
// ---------------------------------------------------------------------------

describe('ALIGN-4 A4-3 — both engineId values identical: no deprecation event', () => {
  it('no deprecated_adapter_engineId event when config and adapters agree on the same value', async () => {
    const { adapters, emitter } = await makeBaseAdapters();

    const deprecatedAdapters: HoplonAdapters = {
      ...adapters,
      engineId: 'same-engine',
    };

    // Both config.engineId and adapters.engineId are 'same-engine'
    const engine = await createHoplonEngine(deprecatedAdapters, {
      engineId: 'same-engine',
      fsRoot: '/',
    });

    // No deprecation event — both agree
    const deprecationEvents = emitter
      .getEvents()
      .filter((e) => e.errorKind === 'deprecated_adapter_engineId');
    expect(deprecationEvents).toHaveLength(0);

    // Engine functions normally
    const h = await engine.health();
    expect(h.engineId).toBe('same-engine');
  });
});

// ---------------------------------------------------------------------------
// A4-4: both set and different → ValidationError({ kind: 'conflicting_adapters' })
// ---------------------------------------------------------------------------

describe('ALIGN-4 A4-4 — both engineId values different: ValidationError', () => {
  it('throws ValidationError conflicting_adapters when config and adapters have different engineId', async () => {
    const { adapters } = await makeBaseAdapters();

    const deprecatedAdapters: HoplonAdapters = {
      ...adapters,
      engineId: 'adapters-engine',
    };

    await expect(
      createHoplonEngine(deprecatedAdapters, {
        engineId: 'config-engine', // different from adapters.engineId
        fsRoot: '/',
      }),
    ).rejects.toBeInstanceOf(ValidationError);

    const err = await createHoplonEngine(deprecatedAdapters, {
      engineId: 'config-engine',
      fsRoot: '/',
    }).catch((e: unknown) => e);

    expect(err).toBeInstanceOf(ValidationError);
    expect((err as ValidationError).kind).toBe('conflicting_adapters');
    expect((err as ValidationError).correlationId).toBe('factory');
  });

  it('ValidationError is thrown before any emitter event (emitter not yet confirmed present)', async () => {
    const { adapters, emitter } = await makeBaseAdapters();

    const deprecatedAdapters: HoplonAdapters = {
      ...adapters,
      engineId: 'adapters-engine',
    };

    await createHoplonEngine(deprecatedAdapters, {
      engineId: 'config-engine',
      fsRoot: '/',
    }).catch(() => {
      // expected
    });

    // No deprecation event should have been emitted (error thrown before step 2.6)
    const deprecationEvents = emitter
      .getEvents()
      .filter((e) => e.errorKind === 'deprecated_adapter_engineId');
    expect(deprecationEvents).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// H13 content-free audit: deprecation event carries no content fields
// ---------------------------------------------------------------------------

describe('ALIGN-4 H13 content-free audit — deprecation event schema compliance', () => {
  it('deprecated_adapter_engineId event contains only structural fields (no content)', async () => {
    const { adapters, emitter } = await makeBaseAdapters();

    await createHoplonEngine(
      { ...adapters, engineId: 'h13-test-engine' },
      { fsRoot: '/' },
    );

    const evt = emitter
      .getEvents()
      .find((e) => e.errorKind === 'deprecated_adapter_engineId');

    expect(evt).toBeDefined();
    // Verify only allowed structural fields are present (HoplonEventSchema.strict() enforces this)
    const allowedKeys = new Set([
      'op', 'phase', 'engineId', 'correlationId', 'errorCategory', 'errorKind',
      'durationMs', 'classification', 'projectId', 'runId',
    ]);
    for (const key of Object.keys(evt!)) {
      expect(allowedKeys.has(key)).toBe(true);
    }

    // Critical H13 check: no content-bearing field values
    // (The schema's .strict() already rejects unknown fields at emit time,
    // but we verify the known content-bearing fields are absent.)
    expect(evt!.projectId).toBeUndefined();
    expect(evt!.runId).toBeUndefined();
    expect(evt!.durationMs).toBeUndefined();
    expect(evt!.classification).toBeUndefined();
  });
});
