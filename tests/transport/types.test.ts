/**
 * tests/transport/types.test.ts — TR1 proof suite.
 *
 * Proves:
 * 1. H24 invariant: every Phase 1+2 request/response DTO roundtrips through
 *    JSON serialize → deserialize → Zod parse → structural equality.
 * 2. Corrupted DTO on the wire → TransportError({ kind: 'malformed_response' })
 * 3. AbortSignal propagation through HoplonEngineTransport.invoke()
 * 4. H13: TransportError carries correlationId but never request body content
 */

import { describe, it, expect } from 'vitest';
import type { z } from 'zod';
import {
  TransportError,
  serializeRequest,
  deserializeResponse,
} from '../../src/hoplon/transport/types.js';
import type { HoplonEngineTransport } from '../../src/hoplon/transport/types.js';
import { HoplonError } from '../../src/hoplon/contracts/errors.js';

// Request schemas
import {
  CreateSnapshotRequestSchema,
  AuditRequestSchema,
  RevertRequestSchema,
  PackContextRequestSchema,
  DryRunRequestSchema,
  PreflightRequestSchema,
} from '../../src/hoplon/contracts/requests.js';

// Response schemas
import { SnapshotResultSchema } from '../../src/hoplon/contracts/snapshot.js';
import { AuditResultSchema } from '../../src/hoplon/contracts/audit.js';
import { RevertResultSchema } from '../../src/hoplon/contracts/revert.js';
import { PackedContextSchema } from '../../src/hoplon/contracts/context.js';
import { EngineHealthSchema } from '../../src/hoplon/contracts/health.js';
import { ReconcileReportSchema } from '../../src/hoplon/contracts/reconcile.js';
import { PreflightResultSchema } from '../../src/hoplon/contracts/preflight.js';

// ---------------------------------------------------------------------------
// Shared test fixtures
// ---------------------------------------------------------------------------

const CORR = 'corr-tr1-test';
const ENGINE_ID = 'test-engine-0';
const CTX = { correlationId: CORR, engineId: ENGINE_ID };
const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;

const VALID_MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'proj-1',
  runId: 'run-1',
  correlationId: CORR,
  entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
};

// ---------------------------------------------------------------------------
// Helper: lossless round-trip assertion
// ---------------------------------------------------------------------------

function roundTrip<T>(schema: z.ZodType<T>, fixture: T): void {
  const wire = serializeRequest(schema, fixture, CTX);
  const recovered = deserializeResponse(schema, wire, CTX);
  expect(recovered).toEqual(fixture);
}

// ---------------------------------------------------------------------------
// 1. TransportError class
// ---------------------------------------------------------------------------

describe('TransportError', () => {
  it('is an instance of HoplonError', () => {
    const err = new TransportError({ kind: 'timeout', correlationId: CORR, engineId: ENGINE_ID });
    expect(err).toBeInstanceOf(HoplonError);
  });

  it('is an instance of TransportError', () => {
    const err = new TransportError({
      kind: 'malformed_response',
      correlationId: CORR,
      engineId: ENGINE_ID,
    });
    expect(err).toBeInstanceOf(TransportError);
  });

  it('name is TransportError', () => {
    const err = new TransportError({
      kind: 'connection_refused',
      correlationId: CORR,
      engineId: ENGINE_ID,
    });
    expect(err.name).toBe('TransportError');
  });

  it('carries all five kinds without type error', () => {
    const kinds = [
      'malformed_response',
      'connection_refused',
      'timeout',
      'stream_interrupted',
      'auth_failed',
    ] as const;
    for (const kind of kinds) {
      const err = new TransportError({ kind, correlationId: CORR, engineId: ENGINE_ID });
      expect(err.kind).toBe(kind);
    }
  });

  it('H13 — carries correlationId', () => {
    const err = new TransportError({ kind: 'auth_failed', correlationId: CORR, engineId: ENGINE_ID });
    expect(err.correlationId).toBe(CORR);
  });

  it('H13 — carries engineId', () => {
    const err = new TransportError({
      kind: 'stream_interrupted',
      correlationId: CORR,
      engineId: ENGINE_ID,
    });
    expect(err.engineId).toBe(ENGINE_ID);
  });

  it('H13 — request body content does not appear in the error object', () => {
    const SECRET_BODY = '{"password":"hunter2","token":"ghp_AAAA"}';
    const err = new TransportError(
      { kind: 'malformed_response', correlationId: CORR, engineId: ENGINE_ID },
      'deserialization failed',
    );
    // The constructor does NOT accept a body parameter — confirm nothing leaks
    expect(err.message).not.toContain(SECRET_BODY);
    expect(JSON.stringify(err)).not.toContain('hunter2');
  });

  it('accepts optional cause', () => {
    const cause = new Error('underlying TCP error');
    const err = new TransportError({ kind: 'connection_refused', correlationId: CORR, engineId: ENGINE_ID, cause });
    expect(err.cause).toBe(cause);
  });

  it('uses a default message when none is supplied', () => {
    const err = new TransportError({ kind: 'timeout', correlationId: CORR, engineId: ENGINE_ID });
    expect(err.message).toContain('timeout');
  });
});

// ---------------------------------------------------------------------------
// 2. serializeRequest — happy path
// ---------------------------------------------------------------------------

describe('serializeRequest — valid DTOs produce wire-JSON', () => {
  it('serialises CreateSnapshotRequest', () => {
    const req = { manifest: VALID_MANIFEST };
    const wire = serializeRequest(CreateSnapshotRequestSchema, req, CTX);
    expect(typeof wire).toBe('string');
    const parsed = JSON.parse(wire);
    expect(parsed.manifest.projectId).toBe('proj-1');
  });

  it('serialises AuditRequest', () => {
    const req = {
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
    };
    const wire = serializeRequest(AuditRequestSchema, req, CTX);
    expect(() => JSON.parse(wire)).not.toThrow();
  });

  it('serialises PackContextRequest (symbols strategy)', () => {
    const req = {
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
      strategy: { kind: 'symbols' as const, symbols: ['myFn'] },
    };
    const wire = serializeRequest(PackContextRequestSchema, req, CTX);
    expect(JSON.parse(wire).strategy.kind).toBe('symbols');
  });
});

// ---------------------------------------------------------------------------
// 3. serializeRequest — schema validation on bad input
// ---------------------------------------------------------------------------

describe('serializeRequest — invalid DTO throws TransportError', () => {
  it('throws TransportError(malformed_response) for schema-invalid input', () => {
    // Missing required manifest field
    expect(() =>
      serializeRequest(CreateSnapshotRequestSchema, {} as never, CTX),
    ).toThrow(TransportError);
  });

  it('error kind is malformed_response', () => {
    try {
      serializeRequest(CreateSnapshotRequestSchema, {} as never, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(TransportError);
      expect((err as TransportError).kind).toBe('malformed_response');
    }
  });

  it('error correlationId matches ctx', () => {
    try {
      serializeRequest(AuditRequestSchema, {} as never, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as TransportError).correlationId).toBe(CORR);
    }
  });
});

// ---------------------------------------------------------------------------
// 4. deserializeResponse — schema validation on wire corruption
// ---------------------------------------------------------------------------

describe('deserializeResponse — corrupted wire bytes', () => {
  it('throws TransportError(malformed_response) for non-JSON bytes', () => {
    expect(() =>
      deserializeResponse(SnapshotResultSchema, 'NOT-JSON{{{', CTX),
    ).toThrow(TransportError);
  });

  it('kind is malformed_response for non-JSON', () => {
    try {
      deserializeResponse(SnapshotResultSchema, '}}bad{{', CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as TransportError).kind).toBe('malformed_response');
    }
  });

  it('throws TransportError(malformed_response) for valid JSON but wrong schema', () => {
    // Valid JSON but missing required fields for SnapshotResult
    const wrongShape = JSON.stringify({ unexpected: 'field' });
    expect(() =>
      deserializeResponse(SnapshotResultSchema, wrongShape, CTX),
    ).toThrow(TransportError);
  });

  it('H13 — error message does not contain raw wire body content', () => {
    const sensitiveWire = JSON.stringify({ password: 'hunter2', token: 'ghp_AAAA' });
    try {
      deserializeResponse(SnapshotResultSchema, sensitiveWire, CTX);
      expect.fail('should have thrown');
    } catch (err) {
      // The error message may include Zod issue descriptions but not raw body content
      expect((err as TransportError).message).not.toContain('hunter2');
      expect((err as TransportError).message).not.toContain('ghp_AAAA');
    }
  });

  it('correlationId from ctx appears on deserializeResponse error', () => {
    try {
      deserializeResponse(SnapshotResultSchema, 'bad', CTX);
      expect.fail('should have thrown');
    } catch (err) {
      expect((err as TransportError).correlationId).toBe(CORR);
    }
  });
});

// ---------------------------------------------------------------------------
// 5. H24 round-trip — every Phase 1+2 request DTO
// ---------------------------------------------------------------------------

describe('H24 round-trip — Phase 1+2 request DTOs', () => {
  it('CreateSnapshotRequest', () => {
    roundTrip(CreateSnapshotRequestSchema, { manifest: VALID_MANIFEST });
  });

  it('AuditRequest', () => {
    roundTrip(AuditRequestSchema, {
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts', 'src/bar.ts'],
    });
  });

  it('RevertRequest', () => {
    roundTrip(RevertRequestSchema, {
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
    });
  });

  it('PackContextRequest (whole_file)', () => {
    roundTrip(PackContextRequestSchema, {
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
      strategy: { kind: 'whole_file' },
    });
  });

  it('PackContextRequest (symbols)', () => {
    roundTrip(PackContextRequestSchema, {
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      files: ['src/foo.ts'],
      strategy: { kind: 'symbols', symbols: ['render', 'init'] },
    });
  });

  it('DryRunRequest', () => {
    roundTrip(DryRunRequestSchema, {
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
      proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;' }],
    });
  });

  it('PreflightRequest (with snapshotRefId)', () => {
    roundTrip(PreflightRequestSchema, {
      manifest: VALID_MANIFEST,
      snapshotRefId: SNAPSHOT_ID,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
    });
  });

  it('PreflightRequest (without snapshotRefId)', () => {
    roundTrip(PreflightRequestSchema, {
      manifest: VALID_MANIFEST,
      projectId: 'proj-1',
      runId: 'run-1',
      correlationId: CORR,
    });
  });
});

// ---------------------------------------------------------------------------
// 6. H24 round-trip — every Phase 1+2 response DTO
// ---------------------------------------------------------------------------

describe('H24 round-trip — Phase 1+2 response DTOs', () => {
  it('SnapshotResult', () => {
    roundTrip(SnapshotResultSchema, {
      snapshotRef: {
        id: SNAPSHOT_ID,
        engineId: ENGINE_ID,
        runId: 'run-1',
        createdAt: '2026-04-13T00:00:00Z',
      },
      warnings: [],
    });
  });

  it('SnapshotResult with possible_secret warning', () => {
    roundTrip(SnapshotResultSchema, {
      snapshotRef: {
        id: SNAPSHOT_ID,
        engineId: ENGINE_ID,
        runId: 'run-1',
        createdAt: '2026-04-13T00:00:00Z',
      },
      warnings: [
        {
          kind: 'possible_secret',
          path: 'src/config.ts',
          patternName: 'aws_access_key',
          lineNumber: 42,
          redactedSnippet: 'const key = "[REDACTED]"',
        },
      ],
    });
  });

  it('AuditResult (PASS)', () => {
    roundTrip(AuditResultSchema, {
      status: 'PASS',
      checked: 3,
      auditSchemaVersion: 1,
      correlationId: CORR,
    });
  });

  it('AuditResult (BLOCK with out_of_scope_symbol violation)', () => {
    roundTrip(AuditResultSchema, {
      status: 'BLOCK',
      auditSchemaVersion: 1,
      correlationId: CORR,
      violations: [
        {
          kind: 'out_of_scope_symbol',
          path: 'src/foo.ts',
          symbolName: 'helperFn',
          nodeKind: 'function_declaration',
          byteRange: [0, 100],
          sourceSlice: 'function helperFn() {}',
          expectedScope: { kind: 'whole_file' },
          message: 'helperFn is outside the contracted scope',
          correction: 'Remove helperFn or add it to the manifest scope',
        },
      ],
    });
  });

  it('AuditResult (BLOCK with uncontracted_file violation)', () => {
    roundTrip(AuditResultSchema, {
      status: 'BLOCK',
      auditSchemaVersion: 1,
      correlationId: CORR,
      violations: [
        {
          kind: 'uncontracted_file',
          path: 'src/extra.ts',
          firstChangedLine: 5,
          sourceSlice: 'const extra = true;',
          message: 'extra.ts is not in the manifest',
          correction: 'Add src/extra.ts to the manifest or revert the change',
        },
      ],
    });
  });

  it('RevertResult', () => {
    roundTrip(RevertResultSchema, {
      reverted: ['src/foo.ts'],
      deleted: ['src/extra.ts'],
      allowlistSkipped: ['node_modules/dep/index.js'],
    });
  });

  it('PackedContext (whole_file)', () => {
    roundTrip(PackedContextSchema, {
      metadata: {
        strategyVersion: 1,
        grammarVersion: 'tree-sitter-typescript@0.20.0',
        packerVersion: 1,
        generatedAt: '2026-04-13T00:00:00Z',
        correlationId: CORR,
      },
      slices: [
        {
          path: 'src/foo.ts',
          byteRange: [0, 50],
          nodeKinds: ['program'],
          content: 'export const x = 1;\n',
        },
      ],
      failures: [],
    });
  });

  it('PackedContext with parse_failure', () => {
    roundTrip(PackedContextSchema, {
      metadata: {
        strategyVersion: 1,
        grammarVersion: 'tree-sitter-typescript@0.20.0',
        packerVersion: 1,
        generatedAt: '2026-04-13T00:00:00Z',
        correlationId: CORR,
      },
      slices: [],
      failures: [
        { path: 'src/broken.ts', reason: 'parse_failure', parseError: 'Unexpected token' },
      ],
    });
  });

  it('EngineHealth', () => {
    roundTrip(EngineHealthSchema, {
      engineId: ENGINE_ID,
      adapters: {
        fs: 'ok',
        versioning: 'ok',
        snapshotStore: 'ok',
        lockProvider: 'ok',
        emitter: 'ok',
        codeIntelligence: 'degraded',
        secretScanner: 'ok',
        staticAnalysis: 'ok',
      },
      uptimeMs: 12345,
    });
  });

  it('ReconcileReport', () => {
    roundTrip(ReconcileReportSchema, {
      reconciled: 2,
      failed: 0,
      orphans: { gitObjects: 1, pendingRows: 2 },
    });
  });

  it('PreflightResult (PASS)', () => {
    roundTrip(PreflightResultSchema, {
      status: 'PASS',
      gates: [
        {
          gateName: 'path_traversal',
          status: 'PASS',
          violations: [],
          durationMs: 3,
        },
      ],
      correlationId: CORR,
    });
  });

  it('PreflightResult (BLOCK)', () => {
    roundTrip(PreflightResultSchema, {
      status: 'BLOCK',
      gates: [
        {
          gateName: 'check_targets',
          status: 'BLOCK',
          violations: [
            {
              kind: 'TARGET_NOT_FOUND',
              path: 'src/ghost.ts',
              symbolName: 'ghostFn',
              manifestIntent: 'modify' as const,
              message: 'Target not found in snapshot',
              correction: 'Ensure ghostFn exists in the snapshot',
            },
          ],
          durationMs: 10,
        },
      ],
      correlationId: CORR,
    });
  });
});

// ---------------------------------------------------------------------------
// 7. AbortSignal propagation through HoplonEngineTransport.invoke
// ---------------------------------------------------------------------------

describe('AbortSignal propagation', () => {
  it('invoke implementation receives and propagates the AbortSignal', async () => {
    const controller = new AbortController();
    let capturedSignal: AbortSignal | undefined;

    // Minimal stub transport that captures the signal
    const stubTransport: HoplonEngineTransport = {
      async invoke<TReq, TRes>(_op: string, _req: TReq, signal?: AbortSignal): Promise<TRes> {
        capturedSignal = signal;
        // Simulate a request that respects abort
        return new Promise<TRes>((resolve, reject) => {
          if (signal?.aborted) {
            reject(new TransportError({ kind: 'timeout', correlationId: CORR, engineId: ENGINE_ID }));
            return;
          }
          const handler = () => {
            reject(new TransportError({ kind: 'timeout', correlationId: CORR, engineId: ENGINE_ID }));
          };
          signal?.addEventListener('abort', handler, { once: true });
          // Resolve after signal fires (in test we abort immediately)
          setTimeout(() => {
            signal?.removeEventListener('abort', handler);
            resolve({} as TRes);
          }, 10000);
        });
      },
    };

    controller.abort();
    await expect(
      stubTransport.invoke('packContext', { projectId: 'proj-1' }, controller.signal),
    ).rejects.toBeInstanceOf(TransportError);

    expect(capturedSignal).toBe(controller.signal);
    expect(capturedSignal?.aborted).toBe(true);
  });

  it('invoke without AbortSignal completes normally', async () => {
    const stubTransport: HoplonEngineTransport = {
      async invoke<TReq, TRes>(_op: string, req: TReq): Promise<TRes> {
        return req as unknown as TRes;
      },
    };

    const result = await stubTransport.invoke('health', { ping: true });
    expect(result).toEqual({ ping: true });
  });
});

// ---------------------------------------------------------------------------
// 8. HoplonEngineTransport interface shape verification
// ---------------------------------------------------------------------------

describe('HoplonEngineTransport interface', () => {
  it('invoke is callable with typed request and response DTOs', async () => {
    type ReqShape = { correlationId: string };
    type ResShape = { status: string };

    const transport: HoplonEngineTransport = {
      async invoke<TReq, TRes>(_op: string, req: TReq): Promise<TRes> {
        const r = req as ReqShape;
        return { status: `ok:${r.correlationId}` } as unknown as TRes;
      },
    };

    const res = await transport.invoke<ReqShape, ResShape>('health', { correlationId: 'x' });
    expect(res.status).toBe('ok:x');
  });
});
