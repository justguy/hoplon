/**
 * tests/operations/preflight.test.ts — PR1 preflight() targeted test suite.
 *
 * 14 required tests (PR1-1 through PR1-14).
 *
 * Uses:
 *   - createMemFsAdapter()           — in-memory fs (C2)
 *   - createIsomorphicGitVersioning() — real in-memory git (C4)
 *   - createIsolatedTestStore()      — in-memory SQLite snapshot store (C1)
 *   - createMemoryEmitter()          — in-memory event store (C5)
 *   - assertEventIsContentFree()     — H13 content-free assertion
 *
 * Critical proofs:
 *   PR1-4: Gate composition (order + mixing)
 *   PR1-10: PATH_ESCAPE violation shape
 *   PR1-12: H11/H13 event emission
 *   PR1-13: event op === 'preflight'
 */

import { describe, it, expect, vi } from 'vitest';

import { preflight, pathTraversalGate, aggregatePreflightResult } from '../../src/hoplon/operations/preflight.js';
import type { PreflightDeps, PreflightGate, PreflightGateContext } from '../../src/hoplon/operations/preflight.js';
import type { PreflightGateResult } from '../../src/hoplon/contracts/preflight.js';
import type { PreflightRequest } from '../../src/hoplon/contracts/requests.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import { ValidationError, EngineError } from '../../src/hoplon/contracts/errors.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createIsomorphicGitVersioning } from '../../src/hoplon/adapters/versioning/isomorphicGit.js';
import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

const FS_ROOT = '/';

/**
 * A more restrictive fsRoot for pathTraversalGate escape testing.
 * With fsRoot = '/sandbox/project', paths like '../escape.ts' would resolve
 * to '/sandbox/escape.ts' which is outside '/sandbox/project'.
 */
const RESTRICTED_FS_ROOT = '/sandbox/project';

// Shared CI — loaded once to avoid repeated WASM loads
let sharedCI: CodeIntelligenceAdapter;

import { beforeAll } from 'vitest';
beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

// ---------------------------------------------------------------------------
// Harness helpers
// ---------------------------------------------------------------------------

/**
 * Build a fresh PreflightDeps for each test.
 * gates defaults to [pathTraversalGate] but can be overridden.
 */
async function makeDeps(opts?: {
  gates?: PreflightGate[];
}): Promise<{
  deps: PreflightDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
}> {
  const fs = createMemFsAdapter();
  const versioning = createIsomorphicGitVersioning({ fs });
  const store = await createIsolatedTestStore();
  const emitter = createMemoryEmitter();

  const deps: PreflightDeps = {
    fs,
    versioning,
    snapshotStore: store,
    codeIntelligence: sharedCI,
    emitter,
    engineId: 'test-engine',
    config: { fsRoot: FS_ROOT },
    gates: opts?.gates ?? [pathTraversalGate],
  };

  return { deps, emitter };
}

/** Build a minimal valid PreflightRequest. */
function makeReq(
  manifest: WritableManifest,
  overrides: Partial<PreflightRequest> = {},
): PreflightRequest {
  return {
    manifest,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    ...overrides,
  };
}

/** A minimal valid manifest with no traversal paths. */
const SAFE_MANIFEST: WritableManifest = {
  manifestSchemaVersion: 1,
  projectId: 'proj-test',
  runId: 'run-001',
  correlationId: 'corr-001',
  entries: [
    { path: 'src/a.ts', scope: { kind: 'whole_file' } },
    { path: 'src/b.ts', scope: { kind: 'symbols', symbols: ['foo'] } },
  ],
};

/**
 * A request with a traversal path — used to call gate.run() DIRECTLY (not via preflight()).
 *
 * Note: the ManifestEntry schema syntactically rejects '..' segments at the Zod level,
 * so TRAVERSAL_MANIFEST cannot be passed through preflight() (the Zod parse catches it
 * as 'invalid_manifest' before the gate runs). Tests that need to exercise the gate's
 * PATH_ESCAPE conversion logic must call gate.run() directly on a manually constructed
 * request that bypasses the schema validation.
 *
 * This is intentional — the manifest schema is H9's first line of defense (syntactic);
 * the pathTraversalGate is H9's second line (semantic, fsRoot-aware). The gate covers
 * edge cases that bypass schema validation (e.g. direct API calls with a cast, future
 * schema relaxations, or callers using the gate standalone).
 */
const TRAVERSAL_REQUEST_DIRECT: PreflightRequest = {
  // Cast past the type system to simulate bypassing Zod schema validation
  // IMPORTANT: Use with RESTRICTED_FS_ROOT ('/sandbox/project'), not FS_ROOT ('/').
  // '../escape.ts' from '/sandbox/project' resolves to '/sandbox/escape.ts'
  // which is genuinely outside '/sandbox/project'.
  manifest: {
    manifestSchemaVersion: 1,
    projectId: 'proj-test',
    runId: 'run-001',
    correlationId: 'corr-001',
    entries: [
      // These would be rejected by ManifestEntrySchema but reach the gate
      // if schema validation were bypassed.
      { path: '../escape.ts', scope: { kind: 'whole_file' } },
    ],
  } as unknown as WritableManifest,
  projectId: 'proj-test',
  runId: 'run-001',
  correlationId: 'corr-001',
};

// ---------------------------------------------------------------------------
// Stub gate factories
// ---------------------------------------------------------------------------

function makeAlwaysPassGate(name = 'stub_pass'): PreflightGate {
  return {
    name,
    async run(): Promise<PreflightGateResult> {
      return { gateName: name, status: 'PASS', violations: [], durationMs: 0 };
    },
  };
}

function makeAlwaysBlockGate(name = 'stub_block'): PreflightGate {
  return {
    name,
    async run(_req: PreflightRequest, _ctx: PreflightGateContext): Promise<PreflightGateResult> {
      return {
        gateName: name,
        status: 'BLOCK',
        violations: [
          {
            kind: 'uncontracted_file',
            path: 'blocked.ts',
            firstChangedLine: 1,
            sourceSlice: '',
            message: 'Stub block gate always blocks.',
            correction: 'Remove blocked.ts from the proposal.',
          },
        ],
        durationMs: 0,
      };
    },
  };
}

function makeThrowingGate(err: Error, name = 'stub_throw'): PreflightGate {
  return {
    name,
    async run(): Promise<PreflightGateResult> {
      throw err;
    },
  };
}

// ---------------------------------------------------------------------------
// PR1-1: Empty registry → PASS
// ---------------------------------------------------------------------------

describe('PR1-1: Empty gate registry → PASS', () => {
  it('returns PASS with empty gates array when no gates registered', async () => {
    const { deps } = await makeDeps({ gates: [] });
    const req = makeReq(SAFE_MANIFEST);
    const result = await preflight(deps, req);

    expect(result.status).toBe('PASS');
    expect(result.gates).toHaveLength(0);
    expect(result.correlationId).toBe('corr-001');
  });
});

// ---------------------------------------------------------------------------
// PR1-2: One PASS gate → PASS
// ---------------------------------------------------------------------------

describe('PR1-2: pathTraversalGate on safe manifest → PASS', () => {
  it('returns PASS with one gate that passes', async () => {
    const { deps } = await makeDeps({ gates: [pathTraversalGate] });
    const req = makeReq(SAFE_MANIFEST);
    const result = await preflight(deps, req);

    expect(result.status).toBe('PASS');
    expect(result.gates).toHaveLength(1);
    const gate = result.gates[0];
    expect(gate).toBeDefined();
    if (gate === undefined) throw new Error('gate undefined');
    expect(gate.gateName).toBe('path_traversal');
    expect(gate.status).toBe('PASS');
    expect(gate.violations).toHaveLength(0);
    expect(gate.durationMs).toBeGreaterThanOrEqual(0);
    expect(result.correlationId).toBe('corr-001');
  });
});

// ---------------------------------------------------------------------------
// PR1-3: One BLOCK gate → BLOCK
// ---------------------------------------------------------------------------

describe('PR1-3: preflight returns BLOCK when a gate returns BLOCK status', () => {
  it('returns BLOCK when stub gate always blocks', async () => {
    const blockGate = makeAlwaysBlockGate('test_block_gate');
    const { deps } = await makeDeps({ gates: [blockGate] });
    const req = makeReq(SAFE_MANIFEST);
    const result = await preflight(deps, req);

    expect(result.status).toBe('BLOCK');
    expect(result.gates).toHaveLength(1);
    const gate = result.gates[0];
    expect(gate).toBeDefined();
    if (gate === undefined) throw new Error('gate undefined');
    expect(gate.status).toBe('BLOCK');
    expect(gate.violations).toHaveLength(1);
    expect('correction' in gate.violations[0]! && gate.violations[0]!.correction.length > 0).toBe(true);
  });

  it('pathTraversalGate.run() directly returns BLOCK for traversal paths (schema bypass)', async () => {
    // Call gate.run() directly to bypass schema validation and test the gate's
    // PATH_ESCAPE conversion logic. This tests the gate's defense-in-depth behavior.
    // Use RESTRICTED_FS_ROOT so '../escape.ts' actually escapes the sandbox.
    const { deps } = await makeDeps({ gates: [pathTraversalGate] });
    const ctx = {
      fs: deps.fs,
      versioning: deps.versioning,
      snapshotStore: deps.snapshotStore,
      codeIntelligence: deps.codeIntelligence,
      emitter: deps.emitter,
      engineId: deps.engineId,
      config: { fsRoot: RESTRICTED_FS_ROOT },  // Use restricted root for escape detection
    };

    const result = await pathTraversalGate.run(TRAVERSAL_REQUEST_DIRECT, ctx);
    expect(result.status).toBe('BLOCK');
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]!.kind).toBe('PATH_ESCAPE');
  });
});

// ---------------------------------------------------------------------------
// PR1-4: Multiple gates, mixed results → gate order preserved, overall BLOCK
// ---------------------------------------------------------------------------

describe('PR1-4: Multiple gates mixed results — gate composition', () => {
  it('BLOCK when one of two gates blocks; gate order is preserved', async () => {
    const passGate = makeAlwaysPassGate('gate_a');
    const blockGate = makeAlwaysBlockGate('gate_b');
    const { deps } = await makeDeps({ gates: [passGate, blockGate] });
    const req = makeReq(SAFE_MANIFEST);
    const result = await preflight(deps, req);

    expect(result.status).toBe('BLOCK');
    expect(result.gates).toHaveLength(2);
    expect(result.gates[0]!.gateName).toBe('gate_a');
    expect(result.gates[0]!.status).toBe('PASS');
    expect(result.gates[1]!.gateName).toBe('gate_b');
    expect(result.gates[1]!.status).toBe('BLOCK');
  });

  it('PASS when all gates pass', async () => {
    const gateA = makeAlwaysPassGate('gate_a');
    const gateB = makeAlwaysPassGate('gate_b');
    const { deps } = await makeDeps({ gates: [gateA, gateB] });
    const req = makeReq(SAFE_MANIFEST);
    const result = await preflight(deps, req);

    expect(result.status).toBe('PASS');
    expect(result.gates).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// PR1-5: Signal pre-aborted → rejects, no gate runs
// ---------------------------------------------------------------------------

describe('PR1-5: Pre-aborted signal → rejects before any gate runs', () => {
  it('throws without running any gate when signal is already aborted', async () => {
    const spyGate: PreflightGate = {
      name: 'spy_gate',
      run: vi.fn().mockResolvedValue({
        gateName: 'spy_gate',
        status: 'PASS',
        violations: [],
        durationMs: 0,
      }),
    };

    const { deps } = await makeDeps({ gates: [spyGate] });
    const req = makeReq(SAFE_MANIFEST);
    const abortedSignal = AbortSignal.abort();

    await expect(preflight(deps, req, abortedSignal)).rejects.toThrow();
    expect(spyGate.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR1-6: Gate throws EngineError → preflight emits 'error' and re-throws
// ---------------------------------------------------------------------------

describe('PR1-6: Gate throws EngineError → emit error + re-throw', () => {
  it('emits error event and re-throws EngineError from gate', async () => {
    const engineErr = new EngineError(
      { kind: 'missing_adapter', engineId: 'test-engine', correlationId: 'corr-001' },
      'test gate throws EngineError',
    );
    const throwingGate = makeThrowingGate(engineErr);

    const { deps, emitter } = await makeDeps({ gates: [throwingGate] });
    const req = makeReq(SAFE_MANIFEST);

    await expect(preflight(deps, req)).rejects.toThrow(EngineError);

    const events = emitter.getEvents();
    const errorEvent = events.find((e) => e.phase === 'error');
    expect(errorEvent).toBeDefined();
    expect(errorEvent?.op).toBe('preflight');
    expect(errorEvent?.errorCategory).toBe('engine');
    expect(errorEvent?.errorKind).toBe('missing_adapter');
  });
});

// ---------------------------------------------------------------------------
// PR1-7: Gate order preserved
// ---------------------------------------------------------------------------

describe('PR1-7: Gate order preserved in result.gates[]', () => {
  it('gates are returned in registration order', async () => {
    const names = ['gate_c', 'gate_a', 'gate_b'];
    const gates = names.map((n) => makeAlwaysPassGate(n));
    const { deps } = await makeDeps({ gates });
    const req = makeReq(SAFE_MANIFEST);
    const result = await preflight(deps, req);

    expect(result.gates.map((g) => g.gateName)).toEqual(names);
  });
});

// ---------------------------------------------------------------------------
// PR1-8: Invalid correlationId → ValidationError, no gate runs
// ---------------------------------------------------------------------------

describe('PR1-8: Invalid correlationId → ValidationError, no gate runs', () => {
  it('throws ValidationError kind invalid_correlation_id for empty correlationId', async () => {
    const spyGate: PreflightGate = {
      name: 'spy_gate',
      run: vi.fn().mockResolvedValue({
        gateName: 'spy_gate',
        status: 'PASS',
        violations: [],
        durationMs: 0,
      }),
    };
    const { deps } = await makeDeps({ gates: [spyGate] });
    const req = makeReq(SAFE_MANIFEST, { correlationId: '' });

    // Zod will reject empty string for correlationId first
    await expect(preflight(deps, req)).rejects.toThrow(ValidationError);
    expect(spyGate.run).not.toHaveBeenCalled();
  });

  it('throws ValidationError kind invalid_correlation_id for whitespace-only correlationId', async () => {
    // The request will pass Zod (non-empty string) but validateCorrelationId should reject whitespace
    const spyGate: PreflightGate = {
      name: 'spy_gate',
      run: vi.fn().mockResolvedValue({
        gateName: 'spy_gate',
        status: 'PASS',
        violations: [],
        durationMs: 0,
      }),
    };
    const { deps } = await makeDeps({ gates: [spyGate] });

    // Build a request that has a whitespace-only correlationId by bypassing Zod
    const rawReq = {
      manifest: SAFE_MANIFEST,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: '   ',
    } as unknown as PreflightRequest;

    await expect(preflight(deps, rawReq)).rejects.toThrow(ValidationError);
    expect(spyGate.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR1-9: Invalid runId → ValidationError
// ---------------------------------------------------------------------------

describe('PR1-9: Invalid runId → ValidationError', () => {
  it('throws ValidationError for empty runId', async () => {
    const spyGate: PreflightGate = {
      name: 'spy_gate',
      run: vi.fn().mockResolvedValue({
        gateName: 'spy_gate',
        status: 'PASS',
        violations: [],
        durationMs: 0,
      }),
    };
    const { deps } = await makeDeps({ gates: [spyGate] });
    const req = makeReq(SAFE_MANIFEST, { runId: '' });

    await expect(preflight(deps, req)).rejects.toThrow(ValidationError);
    expect(spyGate.run).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// PR1-10: PATH_ESCAPE violation shape
//
// Note: ManifestEntry schema rejects '..' segments syntactically (H9 first line).
// These tests call pathTraversalGate.run() directly to test the gate's PATH_ESCAPE
// conversion logic without going through preflight()'s Zod validation. This is the
// correct test pattern — the gate is also callable standalone (e.g. by LC1 composing it).
// ---------------------------------------------------------------------------

describe('PR1-10: Path traversal gate emits correct PATH_ESCAPE shape', () => {
  it('violation has correct kind, path, non-empty message + correction', async () => {
    const { deps } = await makeDeps({ gates: [pathTraversalGate] });
    // Use RESTRICTED_FS_ROOT so '../foo.ts' genuinely escapes the sandbox.
    // '../foo.ts' from '/sandbox/project' resolves to '/sandbox/foo.ts' — outside.
    const ctx = {
      fs: deps.fs,
      versioning: deps.versioning,
      snapshotStore: deps.snapshotStore,
      codeIntelligence: deps.codeIntelligence,
      emitter: deps.emitter,
      engineId: deps.engineId,
      config: { fsRoot: RESTRICTED_FS_ROOT },
    };

    // Build request directly, bypassing schema to test gate's defense-in-depth
    const directReq: PreflightRequest = {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-001',
        entries: [{ path: '../foo.ts', scope: { kind: 'whole_file' } }],
      } as unknown as WritableManifest,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
    };

    const gateResult = await pathTraversalGate.run(directReq, ctx);

    expect(gateResult.status).toBe('BLOCK');
    expect(gateResult.violations).toHaveLength(1);

    const v = gateResult.violations[0];
    expect(v).toBeDefined();
    if (v === undefined) throw new Error('violation undefined');

    expect(v.kind).toBe('PATH_ESCAPE');
    if (v.kind !== 'PATH_ESCAPE') throw new Error('wrong kind');

    expect(v.path).toBe('../foo.ts');
    expect(v.resolvedPath).toBe('<redacted>');
    expect(v.sandboxRoot).toBe(RESTRICTED_FS_ROOT);
    expect(v.message.length).toBeGreaterThan(0);
    expect(v.correction.length).toBeGreaterThan(0);
  });

  it('multiple traversal paths → multiple PATH_ESCAPE violations', async () => {
    const { deps } = await makeDeps({ gates: [pathTraversalGate] });
    // Use RESTRICTED_FS_ROOT for escape detection.
    const ctx = {
      fs: deps.fs,
      versioning: deps.versioning,
      snapshotStore: deps.snapshotStore,
      codeIntelligence: deps.codeIntelligence,
      emitter: deps.emitter,
      engineId: deps.engineId,
      config: { fsRoot: RESTRICTED_FS_ROOT },
    };

    const directReq: PreflightRequest = {
      manifest: {
        manifestSchemaVersion: 1,
        projectId: 'proj-test',
        runId: 'run-001',
        correlationId: 'corr-001',
        entries: [
          { path: '../foo.ts', scope: { kind: 'whole_file' } },
          { path: '../../bar.ts', scope: { kind: 'whole_file' } },
        ],
      } as unknown as WritableManifest,
      projectId: 'proj-test',
      runId: 'run-001',
      correlationId: 'corr-001',
    };

    const gateResult = await pathTraversalGate.run(directReq, ctx);

    expect(gateResult.status).toBe('BLOCK');
    expect(gateResult.violations).toHaveLength(2);
    expect(gateResult.violations.every((v) => v.kind === 'PATH_ESCAPE')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR1-11: aggregatePreflightResult unit test
// ---------------------------------------------------------------------------

describe('PR1-11: aggregatePreflightResult helper', () => {
  const makeFakeGateResult = (status: 'PASS' | 'BLOCK' | 'SKIPPED', name = 'g'): PreflightGateResult => ({
    gateName: name,
    status,
    violations: [],
    durationMs: 0,
  });

  it('all PASS → PASS', () => {
    const result = aggregatePreflightResult(
      [makeFakeGateResult('PASS', 'a'), makeFakeGateResult('PASS', 'b')],
      'corr-x',
    );
    expect(result.status).toBe('PASS');
    expect(result.gates).toHaveLength(2);
    expect(result.correlationId).toBe('corr-x');
  });

  it('one BLOCK → BLOCK', () => {
    const result = aggregatePreflightResult(
      [makeFakeGateResult('PASS', 'a'), makeFakeGateResult('BLOCK', 'b')],
      'corr-x',
    );
    expect(result.status).toBe('BLOCK');
  });

  it('all SKIPPED → PASS', () => {
    const result = aggregatePreflightResult(
      [makeFakeGateResult('SKIPPED', 'a'), makeFakeGateResult('SKIPPED', 'b')],
      'corr-x',
    );
    expect(result.status).toBe('PASS');
  });

  it('empty array → PASS', () => {
    const result = aggregatePreflightResult([], 'corr-x');
    expect(result.status).toBe('PASS');
    expect(result.gates).toHaveLength(0);
  });

  it('SKIPPED + BLOCK → BLOCK', () => {
    const result = aggregatePreflightResult(
      [makeFakeGateResult('SKIPPED'), makeFakeGateResult('BLOCK')],
      'corr-x',
    );
    expect(result.status).toBe('BLOCK');
  });

  it('SKIPPED + PASS → PASS', () => {
    const result = aggregatePreflightResult(
      [makeFakeGateResult('SKIPPED'), makeFakeGateResult('PASS')],
      'corr-x',
    );
    expect(result.status).toBe('PASS');
  });
});

// ---------------------------------------------------------------------------
// PR1-12: H11 event emission + H13 content-free
// ---------------------------------------------------------------------------

describe('PR1-12: H11 event emission + H13 content-free', () => {
  it('emits start + end events on PASS run; both are content-free', async () => {
    const { deps, emitter } = await makeDeps({ gates: [pathTraversalGate] });
    const req = makeReq(SAFE_MANIFEST);

    await preflight(deps, req);

    const events = emitter.getEvents();
    expect(events.length).toBeGreaterThanOrEqual(2);

    const startEvent = events.find((e) => e.phase === 'start');
    const endEvent = events.find((e) => e.phase === 'end');

    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();

    // H13 assertion on each event
    assertEventIsContentFree(startEvent);
    assertEventIsContentFree(endEvent);
  });

  it('emits start + end events on BLOCK run; both are content-free', async () => {
    const blockGate = makeAlwaysBlockGate('block_for_h13_test');
    const { deps, emitter } = await makeDeps({ gates: [blockGate] });
    const req = makeReq(SAFE_MANIFEST);

    await preflight(deps, req);

    const events = emitter.getEvents();
    const startEvent = events.find((e) => e.phase === 'start');
    const endEvent = events.find((e) => e.phase === 'end');

    expect(startEvent).toBeDefined();
    expect(endEvent).toBeDefined();
    if (startEvent === undefined || endEvent === undefined) throw new Error('events undefined');

    assertEventIsContentFree(startEvent);
    assertEventIsContentFree(endEvent);

    expect(endEvent.classification).toBe('BLOCK');
  });
});

// ---------------------------------------------------------------------------
// PR1-13: Event op includes 'preflight'
// ---------------------------------------------------------------------------

describe('PR1-13: Event op === "preflight"', () => {
  it('all emitted events have op: "preflight"', async () => {
    const { deps, emitter } = await makeDeps({ gates: [pathTraversalGate] });
    const req = makeReq(SAFE_MANIFEST);

    await preflight(deps, req);

    const events = emitter.getEvents();
    expect(events.length).toBeGreaterThan(0);
    expect(events.every((e) => e.op === 'preflight')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// PR1-14: Backward compat — v1 manifest works unchanged
// ---------------------------------------------------------------------------

describe('PR1-14: v1 manifest (no intent, no signatureContracts) → PASS with valid paths', () => {
  it('pathTraversalGate passes v1 manifest with valid paths', async () => {
    const v1Manifest: WritableManifest = {
      manifestSchemaVersion: 1,
      projectId: 'proj-compat',
      runId: 'run-compat',
      correlationId: 'corr-compat',
      entries: [
        { path: 'src/main.ts', scope: { kind: 'whole_file' } },
        { path: 'src/util.ts', scope: { kind: 'symbols', symbols: ['helper'] } },
      ],
      // No intent, no signatureContracts — pure v1 shape
    };

    const { deps } = await makeDeps({ gates: [pathTraversalGate] });
    const req = makeReq(v1Manifest, {
      projectId: 'proj-compat',
      runId: 'run-compat',
      correlationId: 'corr-compat',
    });
    const result = await preflight(deps, req);

    expect(result.status).toBe('PASS');
    expect(result.gates[0]!.status).toBe('PASS');
    expect(result.gates[0]!.violations).toHaveLength(0);
  });
});
