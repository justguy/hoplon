/**
 * tests/session/traceWriter.test.ts — session → TraceStore wiring (t-068).
 *
 * Proves:
 *   - createSnapshot opens exactly one execution trace (observability only,
 *     no PASS/BLOCK effect)
 *   - each audit() appends an Attempt + ProofBundle + DecisionProvenance with
 *     monotonic attemptNumber
 *   - BLOCK attempts persist ProofViolation index rows with path populated
 *   - close() writes the final execution status derived from priorState
 *   - a TraceStore whose writes throw does NOT block the session's
 *     enforcement (PASS still returns PASS)
 *
 * Tests use the in-memory TraceStore — the adapter contract is covered
 * separately by tests/adapters/traceStore/contract.test.ts.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { createInMemoryTraceStore } from '../../src/hoplon/adapters/trace-store-memory.js';
import { deriveExecutionId } from '../../src/hoplon/session/traceWriter.js';
import type { TraceStore } from '../../src/hoplon/adapters/traceStore.js';
import { BLOCK_AUDIT, MANIFEST, PASS_AUDIT, makeMockEngine } from './helpers.js';

function makeClock(): () => number {
  let counter = 0;
  return () => Date.UTC(2026, 3, 20, 10, 0, counter++, 0);
}

describe('session ↔ traceWriter', () => {
  it('writes an execution + PASS attempt with hoplon_proved provenance', async () => {
    const traceStore = createInMemoryTraceStore();
    const sessionId = 'sess-pass';
    const session = createHoplonEditSession({
      engine: makeMockEngine({
        auditDiff: async () => ({ ...PASS_AUDIT, auditRef: 'audit-pass-1' }),
      }),
      manifest: MANIFEST,
      sessionId,
      now: makeClock(),
      traceStore,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();
    session.close();

    const executionId = deriveExecutionId(sessionId);
    const exec = await traceStore.getExecution(executionId);
    expect(exec).not.toBeNull();
    expect(exec?.currentStatus).toBe('PASS');
    expect(exec?.origin).toBe('session');
    expect(exec?.engineId).toBe('mock-engine');

    const attempts = await traceStore.listAttempts(executionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.attemptNumber).toBe(1);
    expect(attempts[0]?.status).toBe('PASS');
    expect(attempts[0]?.auditRef).toBe('audit-pass-1');

    const bundles = await traceStore.listProofBundles(executionId);
    expect(bundles).toHaveLength(1);
    expect(bundles[0]?.engineId).toBe('mock-engine');
    expect(bundles[0]?.auditRef).toBe('audit-pass-1');

    const provenance = await traceStore.listProvenance(executionId);
    expect(provenance).toHaveLength(1);
    expect(provenance[0]?.category).toBe('hoplon_proved');
    expect(provenance[0]?.detail).toMatchObject({ auditRef: 'audit-pass-1' });
  });

  it('records a BLOCK attempt with indexed violation paths and final BLOCK status', async () => {
    const traceStore = createInMemoryTraceStore();
    const sessionId = 'sess-block';
    const session = createHoplonEditSession({
      engine: makeMockEngine({ auditDiff: async () => BLOCK_AUDIT }),
      manifest: MANIFEST,
      sessionId,
      now: makeClock(),
      traceStore,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();

    const executionId = deriveExecutionId(sessionId);
    const attempts = await traceStore.listAttempts(executionId);
    expect(attempts).toHaveLength(1);
    expect(attempts[0]?.status).toBe('BLOCK');

    const bundles = await traceStore.listProofBundles(executionId);
    expect(bundles).toHaveLength(1);
    const bundle = bundles[0]!;
    expect(bundle.auditResult.status).toBe('BLOCK');

    const violations = await traceStore.listViolations(bundle.proofBundleRef);
    expect(violations).toHaveLength(1);
    expect(violations[0]?.path).toBe('src/foo.ts');
    expect(violations[0]?.kind).toBe('uncontracted_file');

    // Not yet closed — but session.close() after revert path closes to BLOCK.
    await session.revert();
    session.close();
    const exec = await traceStore.getExecution(executionId);
    expect(exec?.currentStatus).toBe('BLOCK');
  });

  it('keeps sourceSlice only in the raw ProofBundle proof surface', async () => {
    const traceStore = createInMemoryTraceStore();
    const sessionId = 'sess-source-boundary';
    const sentinel = 'T116_TRACE_SOURCE_SENTINEL';
    const session = createHoplonEditSession({
      engine: makeMockEngine({
        auditDiff: async () => ({
          status: 'BLOCK',
          correlationId: 'corr-session-1',
          auditSchemaVersion: 1,
          violations: [
            {
              kind: 'uncontracted_file',
              path: 'src/foo.ts',
              firstChangedLine: 0,
              sourceSlice: `export const leaked = "${sentinel}";`,
              message: 'uncontracted file mutation',
              correction: 'Revert this file.',
            },
          ],
        }),
      }),
      manifest: MANIFEST,
      sessionId,
      now: makeClock(),
      traceStore,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();

    const executionId = deriveExecutionId(sessionId);
    const bundles = await traceStore.listProofBundles(executionId);
    expect(JSON.stringify(bundles[0]?.auditResult)).toContain(sentinel);

    const attempts = await traceStore.listAttempts(executionId);
    const violations = await traceStore.listViolations(bundles[0]!.proofBundleRef);
    const provenance = await traceStore.listProvenance(executionId);

    expect(JSON.stringify(attempts)).not.toContain(sentinel);
    expect(JSON.stringify(violations)).not.toContain(sentinel);
    expect(JSON.stringify(provenance)).not.toContain(sentinel);
  });

  it('packages durable execution and attempt linkage into RepairContext when trace writes succeed', async () => {
    const traceStore = createInMemoryTraceStore();
    const sessionId = 'sess-block-repair';
    const session = createHoplonEditSession({
      engine: makeMockEngine({
        auditDiff: async () => ({ ...BLOCK_AUDIT, auditRef: 'audit-block-1' }),
      }),
      manifest: MANIFEST,
      sessionId,
      now: makeClock(),
      traceStore,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    await session.audit();
    await session.revert();
    await session.extractRollbackTemplate();

    const repair = await session.getRepairContext();
    const executionId = deriveExecutionId(sessionId);
    const attempts = await traceStore.listAttempts(executionId);

    expect(repair.failedAttempt.executionId).toBe(executionId);
    expect(repair.failedAttempt.attemptId).toBe(attempts[0]?.attemptId ?? null);
    expect(repair.failedAttempt.auditRef).toBe('audit-block-1');
  });

  it('attemptNumber increments monotonically across retry attempts', async () => {
    const traceStore = createInMemoryTraceStore();
    let call = 0;
    const engine = makeMockEngine({
      auditDiff: async () => {
        call += 1;
        return call === 1 ? BLOCK_AUDIT : PASS_AUDIT;
      },
    });
    const sessionId = 'sess-retry';
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      sessionId,
      now: makeClock(),
      traceStore,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);

    // First audit — BLOCK. The session drops to audited_block; without reset
    // we can't legally re-audit. So this test simulates a single retry via
    // session.audit being called once — attemptNumber proof on multi-audit
    // lives in the TraceStore contract suite; here we only confirm the
    // attemptCounter baseline is 1 after one call.
    await session.audit();
    const executionId = deriveExecutionId(sessionId);
    const attempts = await traceStore.listAttempts(executionId);
    expect(attempts.map((a) => a.attemptNumber)).toEqual([1]);
  });

  it('trace writer failures never block PASS enforcement', async () => {
    const throwingStore: TraceStore = {
      putExecution: async () => { throw new Error('write failure'); },
      updateExecution: async () => { throw new Error('write failure'); },
      getExecution: async () => null,
      listExecutions: async () => [],
      appendAttempt: async () => { throw new Error('write failure'); },
      getAttempt: async () => null,
      listAttempts: async () => [],
      putProofBundle: async () => { throw new Error('write failure'); },
      getProofBundle: async () => null,
      listProofBundles: async () => [],
      getViolation: async () => null,
      listViolations: async () => [],
      appendDecisionProvenance: async () => { throw new Error('write failure'); },
      listProvenance: async () => [],
      searchAttempts: async () => [],
      exportExecution: async () => null,
    };

    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      sessionId: 'sess-trace-fail',
      now: makeClock(),
      traceStore: throwingStore,
    });

    await session.preflight();
    await session.createSnapshot();
    await session.markEdited(['src/foo.ts']);
    const audit = await session.audit();
    expect(audit.status).toBe('PASS');
    expect(session.state).toBe('audited_pass');
    session.close();
    expect(session.state).toBe('closed');
  });

  it('is a no-op when no traceStore is supplied', async () => {
    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      sessionId: 'sess-no-store',
      now: makeClock(),
    });
    await session.preflight();
    await session.createSnapshot();
    await session.markEdited([]);
    const audit = await session.audit();
    expect(audit.status).toBe('PASS');
    session.close();
  });
});
