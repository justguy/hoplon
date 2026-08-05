/**
 * tests/authorization/capabilityGate.test.ts — T-147 unit tests for the
 * pure capability assertion core.
 *
 * Drives the full enforcement checklist with an injected clock and a
 * fixture token. No I/O, no transport.
 */

import { describe, expect, it } from 'vitest';

import {
  assertCapability,
  type CapabilityKey,
  type CapabilityOpSpec,
} from '../../src/hoplon/authorization/capabilityGate.js';
import {
  matchGlobAny,
  matchGlobPattern,
} from '../../src/hoplon/authorization/capabilityGlob.js';
import type {
  ScopeClaim,
  TokenCapabilities,
} from '../../src/hoplon/authorization/authorizationAdapter.js';
import type { CapabilityEngagementToken } from '../../src/hoplon/authorization/capabilityToken.js';

const NOW = new Date('2026-05-03T12:00:00.000Z');
const PAST = new Date('2026-05-02T12:00:00.000Z');
const FUTURE = new Date('2026-05-04T12:00:00.000Z');

function makeToken(
  capabilities: TokenCapabilities,
  overrides: Partial<CapabilityEngagementToken> = {},
): CapabilityEngagementToken {
  return Object.freeze({
    token: 'opaque-token-bytes',
    projectId: 'proj-x',
    folder: 'src',
    access: 'read_write',
    principalId: 'agent-a',
    issuedAtIso: PAST.toISOString(),
    expiresAtIso: FUTURE.toISOString(),
    tokenId: 'token-id-1',
    subject: 'agent-a',
    sessionId: 'session-1',
    capabilities,
    policy: {
      engine: 'static',
      source: 'standing_policy',
      decisionId: 'decision-1',
      policyVersion: 'v1',
    },
    ...overrides,
  }) as CapabilityEngagementToken;
}

function makeOp(
  capability: CapabilityKey,
  overrides: Partial<CapabilityOpSpec> = {},
): CapabilityOpSpec {
  return {
    capability,
    projectId: 'proj-x',
    branch: 'main',
    path: 'src/foo.ts',
    sessionId: 'session-1',
    principalId: 'agent-a',
    ...overrides,
  };
}

const wildcard: ScopeClaim = { paths: ['**'], branches: ['**'] };

describe('matchGlobPattern', () => {
  it('matches `**` universally', () => {
    expect(matchGlobPattern('anything/here', '**')).toBe(true);
    expect(matchGlobPattern('', '**')).toBe(true);
  });

  it('matches `prefix/**` with at least one further segment', () => {
    expect(matchGlobPattern('src/foo.ts', 'src/**')).toBe(true);
    expect(matchGlobPattern('src/sub/foo.ts', 'src/**')).toBe(true);
    expect(matchGlobPattern('src', 'src/**')).toBe(true);
    expect(matchGlobPattern('srcfoo', 'src/**')).toBe(false);
    expect(matchGlobPattern('lib/foo.ts', 'src/**')).toBe(false);
  });

  it('matches single-segment `*`', () => {
    expect(matchGlobPattern('foo.ts', '*.ts')).toBe(true);
    expect(matchGlobPattern('src/foo.ts', '*.ts')).toBe(false);
  });

  it('exact match without wildcards', () => {
    expect(matchGlobPattern('src/foo.ts', 'src/foo.ts')).toBe(true);
    expect(matchGlobPattern('src/foo.ts', 'src/bar.ts')).toBe(false);
  });

  it('rejects empty pattern', () => {
    expect(matchGlobPattern('anything', '')).toBe(false);
  });

  it('is case-sensitive (T-147 explicit decision)', () => {
    expect(matchGlobPattern('feature/Login-Fix', 'feature/login-fix')).toBe(false);
    expect(matchGlobPattern('feature/login-fix', 'feature/login-fix')).toBe(true);
  });
});

describe('matchGlobAny', () => {
  it('returns false on empty / undefined arrays', () => {
    expect(matchGlobAny('x', [])).toBe(false);
    expect(matchGlobAny('x', undefined)).toBe(false);
  });

  it('returns true if any pattern matches', () => {
    expect(matchGlobAny('src/foo.ts', ['lib/**', 'src/**'])).toBe(true);
  });
});

describe('assertCapability — expiry', () => {
  it('returns reauth_required when token expired by 1ms', () => {
    const token = makeToken(
      { read: wildcard },
      { expiresAtIso: NOW.toISOString() },
    );
    const result = assertCapability({
      token,
      op: makeOp('read'),
      clock: () => NOW,
    });
    expect(result.kind).toBe('reauth_required');
    if (result.kind === 'reauth_required') {
      expect(result.reason).toBe('token_expired');
    }
  });

  it('returns ok when token fresh', () => {
    const token = makeToken({ read: wildcard });
    const result = assertCapability({
      token,
      op: makeOp('read'),
      clock: () => NOW,
    });
    expect(result.kind).toBe('ok');
  });

  it('treats malformed expiresAtIso as invalid_token', () => {
    const token = makeToken(
      { read: wildcard },
      { expiresAtIso: 'not-a-date' },
    );
    const result = assertCapability({
      token,
      op: makeOp('read'),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') {
      expect(result.reason).toBe('invalid_token');
    }
  });
});

describe('assertCapability — capability key separation (T-142 hard constraint)', () => {
  it('denies write when token has only read', () => {
    const token = makeToken({ read: wildcard });
    const result = assertCapability({
      token,
      op: makeOp('write'),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') {
      expect(result.reason).toBe('capability_missing');
      expect(result.field).toBe('write');
    }
  });

  it('denies read when token has only write', () => {
    const token = makeToken({ write: wildcard });
    const result = assertCapability({
      token,
      op: makeOp('read'),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
  });

  it('allows search when token has search', () => {
    const token = makeToken({ search: wildcard });
    expect(
      assertCapability({ token, op: makeOp('search'), clock: () => NOW }).kind,
    ).toBe('ok');
  });

  it('allows lock and snapshot independently', () => {
    const lockToken = makeToken({ lock: wildcard });
    const snapToken = makeToken({ snapshot: wildcard });
    expect(
      assertCapability({ token: lockToken, op: makeOp('lock'), clock: () => NOW })
        .kind,
    ).toBe('ok');
    expect(
      assertCapability({
        token: snapToken,
        op: makeOp('snapshot'),
        clock: () => NOW,
      }).kind,
    ).toBe('ok');
    expect(
      assertCapability({
        token: lockToken,
        op: makeOp('snapshot'),
        clock: () => NOW,
      }).kind,
    ).toBe('denied');
  });
});

describe('assertCapability — bindings', () => {
  it('denies project mismatch', () => {
    const token = makeToken({ read: wildcard });
    const result = assertCapability({
      token,
      op: makeOp('read', { projectId: 'proj-y' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('project_mismatch');
  });

  it('denies session mismatch', () => {
    const token = makeToken({ read: wildcard });
    const result = assertCapability({
      token,
      op: makeOp('read', { sessionId: 'session-2' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('session_mismatch');
  });

  it('denies task mismatch when token taskId set', () => {
    const token = makeToken({ read: wildcard }, { taskId: 'task-1' });
    const result = assertCapability({
      token,
      op: makeOp('read', { taskId: 'task-2' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('task_mismatch');
  });

  it('ignores task mismatch when token has no taskId', () => {
    const token = makeToken({ read: wildcard });
    expect(
      assertCapability({
        token,
        op: makeOp('read', { taskId: 'task-2' }),
        clock: () => NOW,
      }).kind,
    ).toBe('ok');
  });

  it('denies principal mismatch via subject', () => {
    const token = makeToken({ read: wildcard });
    const result = assertCapability({
      token,
      op: makeOp('read', { principalId: 'agent-b' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('principal_mismatch');
  });
});

describe('assertCapability — branch / path semantics', () => {
  it('denies branch mismatch', () => {
    const token = makeToken({
      read: { paths: ['**'], branches: ['main'] },
    });
    const result = assertCapability({
      token,
      op: makeOp('read', { branch: 'feature/x' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('branch_mismatch');
  });

  it('case-sensitive branch comparison (T-147 explicit choice)', () => {
    const token = makeToken({
      read: { paths: ['**'], branches: ['feature/login-fix'] },
    });
    const result = assertCapability({
      token,
      op: makeOp('read', { branch: 'feature/Login-Fix' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
  });

  it('reauth_required when branch missing on request and token is constrained', () => {
    const token = makeToken({
      read: { paths: ['**'], branches: ['main'] },
    });
    const result = assertCapability({
      token,
      op: makeOp('read', { branch: '' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('reauth_required');
    if (result.kind === 'reauth_required') {
      expect(result.reason).toBe('missing_branch');
    }
  });

  it('allows empty branch when token has wildcard branch', () => {
    const token = makeToken({ read: wildcard });
    expect(
      assertCapability({
        token,
        op: makeOp('read', { branch: '' }),
        clock: () => NOW,
      }).kind,
    ).toBe('ok');
  });

  it('denies path mismatch', () => {
    const token = makeToken({
      read: { paths: ['lib/**'], branches: ['**'] },
    });
    const result = assertCapability({
      token,
      op: makeOp('read', { path: 'src/foo.ts' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('path_mismatch');
  });

  it('deniedPaths takes precedence over allowed paths', () => {
    const token = makeToken({
      read: {
        paths: ['src/**'],
        branches: ['**'],
        deniedPaths: ['src/secrets/**'],
      },
    });
    expect(
      assertCapability({
        token,
        op: makeOp('read', { path: 'src/foo.ts' }),
        clock: () => NOW,
      }).kind,
    ).toBe('ok');
    const result = assertCapability({
      token,
      op: makeOp('read', { path: 'src/secrets/key.txt' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('denied_path_match');
  });

  it('deniedPaths edge case: write capability scoped to src/** but request hits src/.env', () => {
    const token = makeToken({
      write: {
        paths: ['src/**'],
        branches: ['**'],
        deniedPaths: ['**/.env'],
      },
    });
    const result = assertCapability({
      token,
      op: makeOp('write', { path: 'src/.env' }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('denied_path_match');
  });
});

describe('assertCapability — AST constraints', () => {
  it('reauth_required when token has AST constraint but request omits coords', () => {
    const token = makeToken({
      write: {
        paths: ['**'],
        branches: ['**'],
        astNodeIds: ['node-1', 'node-2'],
      },
    });
    const result = assertCapability({
      token,
      op: makeOp('write'),
      clock: () => NOW,
    });
    expect(result.kind).toBe('reauth_required');
    if (result.kind === 'reauth_required') {
      expect(result.reason).toBe('missing_ast_coords');
    }
  });

  it('denies AST mismatch when request id is not in token allowlist', () => {
    const token = makeToken({
      write: {
        paths: ['**'],
        branches: ['**'],
        astNodeIds: ['node-1'],
      },
    });
    const result = assertCapability({
      token,
      op: makeOp('write', { astNodeIds: ['node-99'] }),
      clock: () => NOW,
    });
    expect(result.kind).toBe('denied');
    if (result.kind === 'denied') expect(result.reason).toBe('ast_mismatch');
  });

  it('allows AST id when in allowlist', () => {
    const token = makeToken({
      write: {
        paths: ['**'],
        branches: ['**'],
        astNodeIds: ['node-1'],
      },
    });
    expect(
      assertCapability({
        token,
        op: makeOp('write', { astNodeIds: ['node-1'] }),
        clock: () => NOW,
      }).kind,
    ).toBe('ok');
  });

  it('allows unconstrained tokens with unconstrained requests (no AST claim, no coords)', () => {
    const token = makeToken({
      write: { paths: ['**'], branches: ['**'] },
    });
    expect(
      assertCapability({
        token,
        op: makeOp('write'),
        clock: () => NOW,
      }).kind,
    ).toBe('ok');
  });
});
