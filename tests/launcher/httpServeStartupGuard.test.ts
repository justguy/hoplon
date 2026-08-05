/**
 * tests/launcher/httpServeStartupGuard.test.ts — hcr-010 P4 (RESIDUAL B).
 *
 * `runHttpServe` must evaluate the non-loopback-without-auth startup guard
 * BEFORE it bootstraps the engine + sqlite snapshot store. A refused
 * public-bind misconfig has to fail fast with the typed
 * EngineError(config_invalid) and leak nothing — proven here by mocking
 * `bootstrapEngineWithSnapshotStore` and asserting it was never constructed.
 *
 * The mock throws a sentinel so the loopback / auth-configured / override
 * happy paths are also pinned: those must still REACH bootstrap (proving the
 * guard let them through), whereas the refused path must reject before it.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const { bootstrapSpy } = vi.hoisted(() => ({
  bootstrapSpy: vi.fn(() => {
    throw new Error('BOOTSTRAP_REACHED');
  }),
}));

vi.mock('../../src/hoplon/launcher/snapshotStoreBootstrap.js', () => ({
  bootstrapEngineWithSnapshotStore: bootstrapSpy,
}));

import { runHttpServe } from '../../src/hoplon/launcher/httpServe.js';
import type { AuthRegistry } from '../../src/hoplon/transport/http/auth.js';

beforeEach(() => {
  bootstrapSpy.mockClear();
});

describe('runHttpServe startup guard ordering (hcr-010 P4)', () => {
  it('refuses a non-loopback + no-auth bind BEFORE bootstrapping the engine/store', async () => {
    await expect(
      runHttpServe({ host: '0.0.0.0', listen: false }),
    ).rejects.toMatchObject({ kind: 'config_invalid' });
    // The leak: on the pre-fix ordering the engine/sqlite handle is opened
    // before the guard throws. Fail fast means bootstrap is never reached.
    expect(bootstrapSpy).not.toHaveBeenCalled();
  });

  it('lets a loopback bind through to bootstrap unchanged', async () => {
    await expect(
      runHttpServe({ host: '127.0.0.1', listen: false }),
    ).rejects.toThrow('BOOTSTRAP_REACHED');
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });

  it('lets the no-host default through to bootstrap unchanged', async () => {
    await expect(runHttpServe({ listen: false })).rejects.toThrow(
      'BOOTSTRAP_REACHED',
    );
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });

  it('lets a non-loopback bind with an explicit allowUnauthenticated override bootstrap', async () => {
    await expect(
      runHttpServe({ host: '0.0.0.0', allowUnauthenticated: true, listen: false }),
    ).rejects.toThrow('BOOTSTRAP_REACHED');
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });

  it('lets a non-loopback bind with a configured authRegistry bootstrap', async () => {
    await expect(
      runHttpServe({
        host: '0.0.0.0',
        authRegistry: {} as AuthRegistry,
        listen: false,
      }),
    ).rejects.toThrow('BOOTSTRAP_REACHED');
    expect(bootstrapSpy).toHaveBeenCalledTimes(1);
  });
});
