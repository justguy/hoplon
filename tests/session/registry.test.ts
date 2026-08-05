/**
 * tests/session/registry.test.ts — unit proof for createSessionRegistry.
 *
 * Registry contract proofs:
 *   - start() registers an entry keyed by the session's own sessionId and
 *     returns a live session instance usable through the standard ordered-
 *     loop API.
 *   - get() updates lastAccessedAtMs on every call, so idle-eviction can
 *     reflect transport activity instead of construction time.
 *   - close() evicts and is idempotent on unknown ids.
 *   - dispose() closes and evicts every session and cancels the idle sweep
 *     so the registry is garbage-collectable.
 *   - Idle TTL + injectable scheduler evicts sessions past the cutoff on
 *     each tick, and explicit sweepIdle() is deterministic without wall
 *     time.
 */

import { describe, it, expect } from 'vitest';

import {
  createSessionRegistry,
  type SessionRegistry,
} from '../../src/hoplon/session/registry.js';
import { createInMemoryTraceStore } from '../../src/hoplon/adapters/trace-store-memory.js';
import { deriveExecutionId } from '../../src/hoplon/session/traceWriter.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import type { AuditResult } from '../../src/hoplon/contracts/audit.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { MANIFEST, PASS_AUDIT, SNAPSHOT_REF_ID, makeMockEngine } from './helpers.js';

function makeRegistry(options: Partial<Parameters<typeof createSessionRegistry>[0]> = {}) {
  return createSessionRegistry({ engine: makeMockEngine(), ...options });
}

describe('createSessionRegistry', () => {
  it('registers a session under its own sessionId with creation metadata', () => {
    let tick = 1000;
    const reg = makeRegistry({ now: () => tick });
    const entry = reg.start({ manifest: MANIFEST });
    expect(entry.sessionId).toMatch(/^hoplon-session-/);
    expect(entry.projectId).toBe(MANIFEST.projectId);
    expect(entry.runId).toBe(MANIFEST.runId);
    expect(entry.correlationId).toBe(MANIFEST.correlationId);
    expect(entry.createdAtMs).toBe(1000);
    expect(entry.lastAccessedAtMs).toBe(1000);
    expect(reg.size()).toBe(1);
    expect(reg.list()).toEqual([
      {
        sessionId: entry.sessionId,
        projectId: entry.projectId,
        runId: entry.runId,
        correlationId: entry.correlationId,
        createdAtMs: 1000,
        lastAccessedAtMs: 1000,
      },
    ]);
    reg.dispose();
  });

  it('honors an explicit sessionId override', () => {
    const reg = makeRegistry();
    const entry = reg.start({ manifest: MANIFEST, sessionId: 'hoplon-session-fixed' });
    expect(entry.sessionId).toBe('hoplon-session-fixed');
    expect(reg.get('hoplon-session-fixed')).not.toBeNull();
    reg.dispose();
  });

  it('records the strict session owner on start and surfaces it in list()', async () => {
    const reg = makeRegistry();
    const entry = await reg.start({
      manifest: MANIFEST,
      owner: { principalId: 'agent-a', folder: 'src' },
    });
    expect(entry.owner).toEqual({ principalId: 'agent-a', folder: 'src' });
    expect(reg.list()[0]?.owner).toEqual({ principalId: 'agent-a', folder: 'src' });
    const unowned = await reg.start({
      manifest: { ...MANIFEST, runId: 'run-session-2' },
    });
    expect(unowned.owner).toBeUndefined();
    reg.dispose();
  });

  it('get() updates lastAccessedAtMs on each call', () => {
    let tick = 1000;
    const reg = makeRegistry({ now: () => tick });
    const entry = reg.start({ manifest: MANIFEST });
    expect(entry.lastAccessedAtMs).toBe(1000);
    tick = 2500;
    const again = reg.get(entry.sessionId);
    expect(again?.lastAccessedAtMs).toBe(2500);
    reg.dispose();
  });

  it('get() returns null for unknown ids and does not leak a default entry', () => {
    const reg = makeRegistry();
    expect(reg.get('no-such-id')).toBeNull();
    expect(reg.size()).toBe(0);
    reg.dispose();
  });

  it('close() evicts the session and is idempotent over unknown ids', async () => {
    const reg = makeRegistry();
    const entry = reg.start({ manifest: MANIFEST });
    expect(reg.close(entry.sessionId)).toBe(true);
    expect(reg.size()).toBe(0);
    expect(reg.get(entry.sessionId)).toBeNull();
    // Double-close on unknown id must not throw.
    expect(reg.close(entry.sessionId)).toBe(false);
    expect(reg.close('ghost')).toBe(false);
    reg.dispose();
  });

  it('dispose() closes every live session and is safe to call twice', () => {
    const reg = makeRegistry();
    const a = reg.start({ manifest: MANIFEST });
    const b = reg.start({ manifest: { ...MANIFEST, runId: 'run-session-2' } });
    expect(reg.size()).toBe(2);
    reg.dispose();
    expect(reg.size()).toBe(0);
    expect(reg.get(a.sessionId)).toBeNull();
    expect(reg.get(b.sessionId)).toBeNull();
    // Second dispose() must be a no-op.
    reg.dispose();
  });

  it('sweepIdle() evicts sessions past the cutoff and leaves recent ones', () => {
    let tick = 0;
    const reg = makeRegistry({
      now: () => tick,
      idleTtlMs: 100,
      // Disable the wall-clock interval by providing a no-op scheduler.
      setIntervalImpl: () => null,
      clearIntervalImpl: () => undefined,
    });
    const oldEntry = reg.start({ manifest: MANIFEST });
    tick = 50;
    const freshEntry = reg.start({
      manifest: { ...MANIFEST, runId: 'run-session-2' },
    });
    // At tick 200, oldEntry is 200ms stale; freshEntry is 150ms stale → both evict.
    tick = 200;
    expect(reg.sweepIdle()).toEqual(
      expect.arrayContaining([oldEntry.sessionId, freshEntry.sessionId]),
    );
    expect(reg.size()).toBe(0);
    reg.dispose();
  });

  it('sweepIdle() does not evict when lastAccessedAtMs is inside the window', () => {
    let tick = 0;
    const reg = makeRegistry({
      now: () => tick,
      idleTtlMs: 100,
      setIntervalImpl: () => null,
      clearIntervalImpl: () => undefined,
    });
    const entry = reg.start({ manifest: MANIFEST });
    tick = 80;
    // Access refreshes the idle clock.
    reg.get(entry.sessionId);
    tick = 150;
    expect(reg.sweepIdle()).toEqual([]);
    expect(reg.size()).toBe(1);
    reg.dispose();
  });

  it('schedules a periodic sweep when idleTtlMs is set and cancels it on dispose', () => {
    let tick = 0;
    const cleared: unknown[] = [];
    let sweepFn: (() => void) | null = null;
    const scheduler = {
      setIntervalImpl: (fn: () => void, _ms: number) => {
        sweepFn = fn;
        return 'sweep-handle';
      },
      clearIntervalImpl: (handle: unknown) => {
        cleared.push(handle);
      },
    };

    const reg: SessionRegistry = makeRegistry({
      now: () => tick,
      idleTtlMs: 100,
      sweepIntervalMs: 50,
      ...scheduler,
    });
    expect(typeof sweepFn).toBe('function');

    const entry = reg.start({ manifest: MANIFEST });
    tick = 500;
    sweepFn!();
    expect(reg.size()).toBe(0);
    expect(reg.get(entry.sessionId)).toBeNull();

    reg.dispose();
    expect(cleared).toEqual(['sweep-handle']);
  });

  it('sessions registered here drive the ordered loop through their own API', async () => {
    const reg = makeRegistry();
    const entry = reg.start({ manifest: MANIFEST });
    expect(entry.session.state).toBe('created');
    const preflight = await entry.session.preflight();
    expect(preflight.status).toBe('PASS');
    expect(entry.session.state).toBe('preflighted_pass');
    reg.dispose();
  });

  it('forwards traceStore and engineVersion into started sessions', async () => {
    const traceStore = createInMemoryTraceStore();
    const reg = makeRegistry({
      traceStore,
      engineVersion: '1.2.3-registry',
    });
    const entry = reg.start({
      manifest: MANIFEST,
      sessionId: 'sess-registry-trace',
    });

    await entry.session.preflight();
    await entry.session.createSnapshot();
    await entry.session.markEdited(['src/foo.ts']);
    await entry.session.audit();
    entry.session.close();

    const executionId = deriveExecutionId(entry.sessionId);
    const exec = await traceStore.getExecution(executionId);
    expect(exec?.currentStatus).toBe('PASS');

    const bundles = await traceStore.listProofBundles(executionId);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.engineVersion).toBe('1.2.3-registry');

    reg.dispose();
  });

  it('hcr-009: forwards snapshotStore + revertAllowlist so audits derive coverage with revert semantics', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('export const foo = 1;\n'));
    const snapshotStore = await createIsolatedTestStore();
    await snapshotStore.put({
      id: SNAPSHOT_REF_ID,
      manifestSchemaVersion: 1,
      engineId: 'mock-engine',
      projectId: MANIFEST.projectId,
      runId: MANIFEST.runId,
      correlationId: MANIFEST.correlationId,
      status: 'committed',
      statusReason: null,
      gitRef: null,
      manifest: MANIFEST,
      createdAt: '2026-04-14T00:00:00Z',
      ttlExpires: null,
      replicaIds: [],
      presencePaths: ['src/foo.ts'],
    });
    const captured: { files: string[] | null } = { files: null };
    const auditDiff = async (req: { files: readonly string[] }): Promise<AuditResult> => {
      captured.files = [...req.files];
      return PASS_AUDIT;
    };
    const reg = makeRegistry({
      engine: makeMockEngine({ auditDiff }),
      fs,
      snapshotStore,
      revertAllowlist: ['.git/**', 'node_modules/**', '.hoplon/**', 'dist/**'],
    });
    const entry = await reg.start({ manifest: MANIFEST });
    await entry.session.preflight();
    await entry.session.createSnapshot();
    // Post-snapshot: a revert-allowlisted tree plus a smuggled file.
    await fs.write('dist/bundle.js', new TextEncoder().encode('generated\n'));
    await fs.write('src/evil.ts', new TextEncoder().encode('export const evil = 666;\n'));
    await entry.session.markEdited([]);
    const result = await entry.session.audit();

    expect(captured.files).toEqual(['src/evil.ts']);
    expect(result.coverage).toEqual({
      mode: 'derived',
      declaredFileCount: 0,
      discoveredPostSnapshotFiles: ['src/evil.ts'],
      partialReason: null,
    });
    reg.dispose();
  });

  it('shares a configured aggregate staging ceiling across registered sessions', () => {
    const reg = makeRegistry({
      staging: {
        maxEntryBytes: 5,
        maxAggregateBytes: 5,
      },
    });
    const first = reg.start({ manifest: MANIFEST, sessionId: 'stage-first' });
    const second = reg.start({
      manifest: { ...MANIFEST, runId: 'run-session-2' },
      sessionId: 'stage-second',
    });
    const chunk = {
      seq: 0,
      chunkBytes: new Uint8Array(3),
      isFinal: false,
    } as const;

    first.session.stageContent({ stagingKey: 'first', ...chunk });
    try {
      second.session.stageContent({ stagingKey: 'second', ...chunk });
      throw new Error('expected aggregate staging rejection');
    } catch (error) {
      expect(error).toBeInstanceOf(SessionError);
      expect((error as SessionError).details?.prerequisite).toBe(
        'aggregateStagedBytes',
      );
    }

    expect(reg.close(first.sessionId)).toBe(true);
    expect(
      second.session.stageContent({ stagingKey: 'second', ...chunk }),
    ).toMatchObject({ bytesStaged: 3, complete: false });
    reg.dispose();
  });
});
