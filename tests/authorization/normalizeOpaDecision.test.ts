/**
 * tests/authorization/normalizeOpaDecision.test.ts — unit tests for the
 * pure `normalizeOpaDecision` function (T-145).
 *
 * Covers:
 *   - Each `outcome` happy path (allow, requires_escalation,
 *     requires_approval, deny).
 *   - Each malformed-shape rejection mode required by the brief
 *     (vague roles, invalid scope claim arrays, bad outcome,
 *     missing decisionId / policyVersion, etc.).
 *   - Permissive treatment of unknown extra fields (silently ignored).
 */
import { describe, it, expect } from 'vitest';

import { normalizeOpaDecision } from '../../src/hoplon/authorization/normalizeOpaDecision.js';

function ok(raw: unknown) {
  const r = normalizeOpaDecision(raw);
  if (r.kind !== 'ok') {
    throw new Error(
      `expected ok, got malformed: ${r.field}: ${r.reason}`,
    );
  }
  return r.decision;
}

function malformed(raw: unknown) {
  const r = normalizeOpaDecision(raw);
  if (r.kind !== 'malformed') {
    throw new Error(
      `expected malformed, got ok: outcome=${r.decision.outcome}`,
    );
  }
  return r;
}

describe('normalizeOpaDecision', () => {
  it('rejects non-object roots', () => {
    expect(malformed(null).field).toBe('root');
    expect(malformed('string').field).toBe('root');
    expect(malformed([]).field).toBe('root');
    expect(malformed(42).field).toBe('root');
  });

  it('rejects unknown outcome strings', () => {
    const r = malformed({ outcome: 'maybe', decisionId: 'd', policyVersion: 'v' });
    expect(r.field).toBe('outcome');
  });

  it('requires non-empty decisionId and policyVersion on every variant', () => {
    expect(malformed({ outcome: 'deny', reason: 'r', policyVersion: 'v' }).field).toBe(
      'decisionId',
    );
    expect(malformed({ outcome: 'deny', reason: 'r', decisionId: 'd' }).field).toBe(
      'policyVersion',
    );
  });

  it('accepts an allow decision with valid capabilities', () => {
    const dec = ok({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: { read: { paths: ['**'], branches: ['**'] } },
      expiresInSeconds: 60,
      decisionId: 'd1',
      policyVersion: 'v1',
    });
    expect(dec.outcome).toBe('allow');
    if (dec.outcome !== 'allow') return;
    expect(dec.capabilities.read?.paths).toEqual(['**']);
  });

  it('rejects allow with vague roles (empty capabilities)', () => {
    expect(
      malformed({
        outcome: 'allow',
        source: 'standing_policy',
        capabilities: {},
        expiresInSeconds: 60,
        decisionId: 'd1',
        policyVersion: 'v1',
      }).reason,
    ).toMatch(/vague-role rejection/);
  });

  it('rejects allow with non-positive expiresInSeconds', () => {
    expect(
      malformed({
        outcome: 'allow',
        source: 'standing_policy',
        capabilities: { read: { paths: ['**'], branches: ['**'] } },
        expiresInSeconds: 0,
        decisionId: 'd1',
        policyVersion: 'v1',
      }).field,
    ).toBe('expiresInSeconds');
  });

  it('rejects allow with bad source', () => {
    expect(
      malformed({
        outcome: 'allow',
        source: 'evil',
        capabilities: { read: { paths: ['**'], branches: ['**'] } },
        expiresInSeconds: 60,
        decisionId: 'd1',
        policyVersion: 'v1',
      }).field,
    ).toBe('source');
  });

  it('rejects scope claim with empty paths array', () => {
    const r = malformed({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: { write: { paths: [], branches: ['main'] } },
      expiresInSeconds: 60,
      decisionId: 'd1',
      policyVersion: 'v1',
    });
    expect(r.field).toBe('capabilities.write.paths');
  });

  it('rejects scope claim with empty branches array', () => {
    const r = malformed({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: { write: { paths: ['src/**'], branches: [] } },
      expiresInSeconds: 60,
      decisionId: 'd1',
      policyVersion: 'v1',
    });
    expect(r.field).toBe('capabilities.write.branches');
  });

  it('accepts grantIds when present and rejects empty/invalid entries', () => {
    const dec = ok({
      outcome: 'allow',
      source: 'escalation_grant',
      capabilities: { write: { paths: ['src/**'], branches: ['main'] } },
      expiresInSeconds: 60,
      decisionId: 'd1',
      policyVersion: 'v1',
      grantIds: ['g1'],
    });
    if (dec.outcome !== 'allow') throw new Error('expected allow');
    expect(dec.grantIds).toEqual(['g1']);

    expect(
      malformed({
        outcome: 'allow',
        source: 'escalation_grant',
        capabilities: { write: { paths: ['src/**'], branches: ['main'] } },
        expiresInSeconds: 60,
        decisionId: 'd1',
        policyVersion: 'v1',
        grantIds: [''],
      }).field,
    ).toBe('grantIds[0]');
  });

  it('accepts a requires_escalation decision with allowed escalationKind', () => {
    const dec = ok({
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
      reason: 'requires CTO',
      decisionId: 'd1',
      policyVersion: 'v1',
    });
    expect(dec.outcome).toBe('requires_escalation');
  });

  it('rejects a requires_approval decision with self_service escalationKind', () => {
    expect(
      malformed({
        outcome: 'requires_approval',
        escalationKind: 'self_service',
        requestedScope: { write: { paths: ['src/**'], branches: ['main'] } },
        reason: 'r',
        decisionId: 'd1',
        policyVersion: 'v1',
      }).field,
    ).toBe('escalationKind');
  });

  it('accepts a deny decision with reason', () => {
    const dec = ok({
      outcome: 'deny',
      reason: 'no',
      decisionId: 'd1',
      policyVersion: 'v1',
    });
    expect(dec.outcome).toBe('deny');
  });

  it('silently ignores unknown extra fields on otherwise-valid decisions', () => {
    const dec = ok({
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: { read: { paths: ['**'], branches: ['**'] } },
      expiresInSeconds: 60,
      decisionId: 'd1',
      policyVersion: 'v1',
      futureField: 'unknown',
      anotherFutureField: { nested: true },
    });
    expect(dec.outcome).toBe('allow');
  });

  it('renames requestedScope errors so the field path is unambiguous', () => {
    const r = malformed({
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: 42,
      reason: 'r',
      decisionId: 'd1',
      policyVersion: 'v1',
    });
    expect(r.field).toMatch(/^requestedScope/);
  });
});
