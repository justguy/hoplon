/**
 * Tests for diagnosticEnvelope.
 *
 * A3.1 update: correlationId is now mandatory; runId is optional.
 */

import { describe, it, expect } from 'vitest';
import { diagnosticEnvelope } from '../../src/hoplon/util/diagnosticEnvelope.js';

describe('diagnosticEnvelope', () => {
  it('includes engineId and correlationId always', () => {
    const env = diagnosticEnvelope({
      engineId: 'local-0',
      correlationId: 'corr-abc',
      op: 'createSnapshot',
    });
    expect(env.engineId).toBe('local-0');
    expect(env.correlationId).toBe('corr-abc');
  });

  it('includes projectId only when provided', () => {
    const withProject = diagnosticEnvelope({
      engineId: 'local-0',
      correlationId: 'corr-abc',
      op: 'auditDiff',
      projectId: 'widget-app',
    });
    expect(withProject.projectId).toBe('widget-app');

    const withoutProject = diagnosticEnvelope({
      engineId: 'local-0',
      correlationId: 'corr-abc',
      op: 'auditDiff',
    });
    expect('projectId' in withoutProject).toBe(false);
  });

  it('includes runId only when provided', () => {
    const withRun = diagnosticEnvelope({
      engineId: 'local-0',
      correlationId: 'corr-abc',
      op: 'createSnapshot',
      runId: 'run-001',
    });
    expect(withRun.runId).toBe('run-001');

    const withoutRun = diagnosticEnvelope({
      engineId: 'local-0',
      correlationId: 'corr-abc',
      op: 'createSnapshot',
    });
    expect('runId' in withoutRun).toBe(false);
  });

  it('preserves op verbatim', () => {
    const env = diagnosticEnvelope({
      engineId: 'e',
      correlationId: 'c',
      op: 'revertUncontracted',
    });
    expect(env.op).toBe('revertUncontracted');
  });

  it('timestamp is an ISO 8601 UTC string', () => {
    const env = diagnosticEnvelope({ engineId: 'e', correlationId: 'c', op: 'health' });
    expect(env.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/);
    expect(env.timestamp.endsWith('Z')).toBe(true);
  });

  it('timestamp is parseable as a Date', () => {
    const env = diagnosticEnvelope({ engineId: 'e', correlationId: 'c', op: 'packContext' });
    const parsed = new Date(env.timestamp);
    expect(isNaN(parsed.getTime())).toBe(false);
  });

  it('two sequential envelopes have increasing or equal timestamps', () => {
    const first = diagnosticEnvelope({ engineId: 'e', correlationId: 'c', op: 'a' });
    const second = diagnosticEnvelope({ engineId: 'e', correlationId: 'c', op: 'b' });
    expect(new Date(second.timestamp).getTime()).toBeGreaterThanOrEqual(
      new Date(first.timestamp).getTime(),
    );
  });

  it('different engineIds produce separate envelopes', () => {
    const e1 = diagnosticEnvelope({ engineId: 'engine-1', correlationId: 'c', op: 'op' });
    const e2 = diagnosticEnvelope({ engineId: 'engine-2', correlationId: 'c', op: 'op' });
    expect(e1.engineId).not.toBe(e2.engineId);
  });
});
