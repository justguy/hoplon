import { describe, expect, it } from 'vitest';

import { createOtelEmitter } from '../../src/hoplon/adapters/emitter/otel.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createPolicyAuditSink } from '../../src/hoplon/transport/policyAuditSink.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import type { HoplonEngine } from '../../src/hoplon/engine/types.js';
import type { WritableManifest } from '../../src/hoplon/contracts/manifest.js';
import type { HandshakeAuthzResult } from '../../src/hoplon/launcher/handshakeAuthz.js';
import { makeMockMeter, makeMockTracer } from '../helpers/otelMocks.js';

const SNAPSHOT_ID = `sha256:${'a'.repeat(64)}`;

function manifest(): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: 'project-otel-runtime',
    runId: 'run-otel-runtime',
    correlationId: 'corr-otel-runtime',
    entries: [],
  } as WritableManifest;
}

function mockEngine(): HoplonEngine {
  return {
    preflight: async (req) => ({
      status: 'PASS',
      gates: [{ gateName: 'path_traversal', status: 'PASS', violations: [], durationMs: 1 }],
      correlationId: req.correlationId,
    }),
    createSnapshot: async (req) => ({
      snapshotRef: {
        id: SNAPSHOT_ID,
        engineId: 'engine-otel-runtime',
        runId: req.manifest.runId,
        createdAt: '2026-05-09T00:00:00Z',
      },
      warnings: [],
    }),
  } as unknown as HoplonEngine;
}

function auditStore(rows: AuditLogRecord[]): SnapshotStore {
  return {
    appendAuditLog: async (row: AuditLogRecord) => {
      rows.push(row);
    },
  } as unknown as SnapshotStore;
}

describe('OTel runtime coverage', () => {
  it('emits session lifecycle, policy, and write events from the real registry/session path', async () => {
    const { tracer, spans } = makeMockTracer();
    const { meter, counterRecords } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });
    const registry = createSessionRegistry({
      engine: mockEngine(),
      emitter,
      engineId: 'engine-otel-runtime',
    });

    const entry = await registry.start({ manifest: manifest() });
    await entry.session.preflight();
    await entry.session.createSnapshot();
    await entry.session.markEdited(['src/content-bearing-path.ts']);
    entry.session.close();

    const spanNames = spans.map((span) => span.name);
    expect(spanNames).toContain('hoplon.session');
    expect(spanNames).toContain('hoplon.preflight');
    expect(spanNames).toContain('hoplon.createSnapshot');
    expect(spanNames).toContain('hoplon.markEdited');

    const writeSpan = spans.find((span) => span.name === 'hoplon.markEdited');
    expect(writeSpan?.attributes['hoplon.operation_kind']).toBe('write');
    expect(writeSpan?.attributes['hoplon.project_id']).toBe('project-otel-runtime');
    expect(writeSpan?.attributes['hoplon.run_id']).toBe('run-otel-runtime');
    expect(writeSpan?.attributes['hoplon.count.changed_file']).toBe(1);
    expect(JSON.stringify({ spans, counterRecords })).not.toContain(
      'src/content-bearing-path.ts',
    );
  });

  it('emits policy decision telemetry without leaking policy DTO content', async () => {
    const { tracer, spans } = makeMockTracer();
    const { meter, counterRecords } = makeMockMeter();
    const emitter = createOtelEmitter({ tracer, meter });
    const rows: AuditLogRecord[] = [];
    const sink = createPolicyAuditSink({
      store: auditStore(rows),
      engineId: 'policy-engine',
      emitter,
    });
    const result: HandshakeAuthzResult = {
      kind: 'requires_escalation',
      projectId: 'project-otel-runtime',
      folder: 'src/private-policy-content',
      principalId: 'agent-a',
      escalationKind: 'cto_approval',
      requestedScope: { write: { paths: ['src/private-policy-content/**'], branches: ['main'] } },
      reason: 'approval required for protected path',
      decisionId: 'decision-with-content-never-in-otel',
      policyVersion: 'policy-v1',
    };

    await sink.recordHandshakeAuthzOutcome(
      {
        projectId: 'project-otel-runtime',
        runId: 'run-otel-runtime',
        correlationId: 'corr-policy-runtime',
      },
      result,
      'opa',
      7,
    );

    expect(rows).toHaveLength(1);
    const policySpan = spans.find((span) => span.name === 'hoplon.policyDecision');
    expect(policySpan?.attributes['hoplon.operation_kind']).toBe('policy');
    expect(policySpan?.attributes['hoplon.policy_decision_class']).toBe(
      'requires_escalation',
    );
    expect(policySpan?.attributes['hoplon.count.audit_row']).toBe(1);
    const policyMetric = counterRecords.find(
      (record) => record.name === 'hoplon.policy.decision.count',
    );
    expect(policyMetric?.attributes['hoplon.policy_decision_class']).toBe(
      'requires_escalation',
    );
    const telemetryJson = JSON.stringify({ spans, counterRecords });
    expect(telemetryJson).not.toContain('src/private-policy-content');
    expect(telemetryJson).not.toContain('decision-with-content-never-in-otel');
    expect(telemetryJson).not.toContain('approval required');
  });
});
