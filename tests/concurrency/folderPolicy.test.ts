/**
 * tests/concurrency/folderPolicy.test.ts — t-082 folder-scoped policy
 * contract proof.
 *
 * Proves (per t-082 DoD):
 *   - canonicalization refuses absolute paths, `..`/`.` segments,
 *     empty segments, backslashes, and Windows drive prefixes
 *   - the resolver returns a typed `invalid_folder` result with the
 *     structured reason for bad input (no throwing on path traversal —
 *     callers see a discriminated resolution)
 *   - precedence: most-specific canonical folder wins; a principal-
 *     specific rule beats a principal-agnostic rule at equal
 *     specificity; duplicates at the same `(folder, principalSet)` are
 *     rejected by the validator
 *   - default fallback fires when no rule matches and carries the
 *     explicit policy default
 *   - the validator rejects: bad modes, TTL outside the contract's
 *     [1min, 24h] band, duplicate principals, unknown principal refs
 *     on rules, bad principal kinds, bad folder shapes
 *   - the engagement-token binding + envelope shapes are declared with
 *     the fields every transport needs (one shape across transports)
 */

import { describe, it, expect } from 'vitest';
import {
  canonicalizeProjectRelativeFolder,
  resolveFolderAccess,
  MIN_ENGAGEMENT_TOKEN_TTL_MS,
  MAX_ENGAGEMENT_TOKEN_TTL_MS,
  FolderPolicyError,
} from '../../src/hoplon/concurrency/projectPolicy.js';
import type {
  FolderPolicy,
  EngagementTokenBinding,
  EngagementTokenEnvelope,
} from '../../src/hoplon/concurrency/projectPolicy.js';
import { validateFolderPolicy } from '../../src/hoplon/concurrency/projectPolicyValidation.js';

describe('canonicalizeProjectRelativeFolder', () => {
  it('returns the empty string for the project root (empty or trailing slashes)', () => {
    expect(canonicalizeProjectRelativeFolder('')).toEqual({
      ok: true,
      canonical: '',
    });
    expect(canonicalizeProjectRelativeFolder('/')).toMatchObject({
      ok: false,
      reason: 'absolute_path',
    });
    expect(canonicalizeProjectRelativeFolder('src/')).toEqual({
      ok: true,
      canonical: 'src',
    });
    expect(canonicalizeProjectRelativeFolder('src/hoplon/')).toEqual({
      ok: true,
      canonical: 'src/hoplon',
    });
  });

  it('refuses absolute paths', () => {
    expect(canonicalizeProjectRelativeFolder('/etc/passwd')).toEqual({
      ok: false,
      reason: 'absolute_path',
    });
  });

  it('refuses Windows drive prefixes', () => {
    expect(canonicalizeProjectRelativeFolder('C:/Users')).toEqual({
      ok: false,
      reason: 'windows_drive',
    });
  });

  it('refuses backslashes', () => {
    expect(canonicalizeProjectRelativeFolder('src\\hoplon')).toEqual({
      ok: false,
      reason: 'backslash',
    });
  });

  it('refuses `..` / `.` / empty segments', () => {
    expect(canonicalizeProjectRelativeFolder('..')).toMatchObject({
      ok: false,
      reason: 'parent_segment',
    });
    expect(canonicalizeProjectRelativeFolder('src/..')).toMatchObject({
      ok: false,
      reason: 'parent_segment',
    });
    expect(canonicalizeProjectRelativeFolder('src/./hoplon')).toMatchObject({
      ok: false,
      reason: 'dot_segment',
    });
    expect(canonicalizeProjectRelativeFolder('src//hoplon')).toMatchObject({
      ok: false,
      reason: 'empty_segment',
    });
    expect(canonicalizeProjectRelativeFolder('src//')).toMatchObject({
      ok: false,
      reason: 'empty_segment',
    });
    expect(canonicalizeProjectRelativeFolder('src/hoplon///')).toMatchObject({
      ok: false,
      reason: 'empty_segment',
    });
  });

  it('refuses non-string input', () => {
    expect(canonicalizeProjectRelativeFolder(42)).toEqual({
      ok: false,
      reason: 'not_a_string',
    });
    expect(canonicalizeProjectRelativeFolder(null)).toEqual({
      ok: false,
      reason: 'not_a_string',
    });
    expect(canonicalizeProjectRelativeFolder(undefined)).toEqual({
      ok: false,
      reason: 'not_a_string',
    });
  });
});

function makePolicy(overrides: Partial<FolderPolicy> = {}): FolderPolicy {
  return validateFolderPolicy({
    defaultAccess: 'read_only',
    folderRules: [],
    engagementTokenTtlMs: 15 * 60 * 1000,
    ...overrides,
  });
}

describe('resolveFolderAccess precedence', () => {
  it('falls back to default when no rule matches', () => {
    const policy = makePolicy({
      defaultAccess: 'none',
      folderRules: [{ folder: 'src', access: 'read_write' }],
    });
    const r = resolveFolderAccess(policy, 'tests/launcher');
    expect(r).toEqual({
      kind: 'default_fallback',
      access: 'none',
      canonicalFolder: 'tests/launcher',
    });
  });

  it('matches the most specific folder wins (longest prefix)', () => {
    const policy = makePolicy({
      defaultAccess: 'none',
      folderRules: [
        { folder: 'src', access: 'read_only' },
        { folder: 'src/hoplon/engine', access: 'read_write' },
        { folder: 'src/hoplon', access: 'read_only' },
      ],
    });
    const matched = resolveFolderAccess(policy, 'src/hoplon/engine/types.ts');
    expect(matched.kind).toBe('matched');
    if (matched.kind !== 'matched') throw new Error();
    expect(matched.access).toBe('read_write');
    expect(matched.matchedRuleFolder).toBe('src/hoplon/engine');
  });

  it('the empty-string rule covers the project root and every folder', () => {
    const policy = makePolicy({
      defaultAccess: 'none',
      folderRules: [
        { folder: '', access: 'read_only' },
        { folder: 'src', access: 'read_write' },
      ],
    });
    const root = resolveFolderAccess(policy, '');
    expect(root).toMatchObject({ kind: 'matched', access: 'read_only' });
    const src = resolveFolderAccess(policy, 'src/foo');
    // More specific rule wins.
    expect(src).toMatchObject({ kind: 'matched', access: 'read_write' });
    const other = resolveFolderAccess(policy, 'docs');
    expect(other).toMatchObject({ kind: 'matched', access: 'read_only' });
  });

  it('a principal-specific rule beats a principal-agnostic rule at equal specificity', () => {
    const policy = makePolicy({
      defaultAccess: 'none',
      principals: [
        { principalId: 'agent-a', kind: 'agent' },
        { principalId: 'agent-b', kind: 'agent' },
      ],
      folderRules: [
        { folder: 'src', access: 'read_only' },
        {
          folder: 'src',
          access: 'read_write',
          appliesToPrincipalIds: ['agent-a'],
        },
      ],
    });
    const a = resolveFolderAccess(policy, 'src/x', 'agent-a');
    expect(a).toMatchObject({ kind: 'matched', access: 'read_write' });
    const b = resolveFolderAccess(policy, 'src/x', 'agent-b');
    expect(b).toMatchObject({ kind: 'matched', access: 'read_only' });
    const anon = resolveFolderAccess(policy, 'src/x');
    // No principalId ⇒ principal-specific rule is not considered.
    expect(anon).toMatchObject({ kind: 'matched', access: 'read_only' });
  });

  it('returns `invalid_folder` with a structured reason on path-traversal input', () => {
    const policy = makePolicy();
    expect(resolveFolderAccess(policy, '../etc')).toEqual({
      kind: 'invalid_folder',
      reason: 'parent_segment',
    });
    expect(resolveFolderAccess(policy, '/absolute')).toEqual({
      kind: 'invalid_folder',
      reason: 'absolute_path',
    });
  });
});

describe('validateFolderPolicy', () => {
  it('rejects an invalid defaultAccess mode', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'open' as unknown as FolderPolicy['defaultAccess'],
        folderRules: [],
        engagementTokenTtlMs: 15 * 60 * 1000,
      }),
    ).toThrow(FolderPolicyError);
  });

  it('rejects TTL outside the contract band [1min, 24h]', () => {
    for (const ttl of [
      MIN_ENGAGEMENT_TOKEN_TTL_MS - 1,
      MAX_ENGAGEMENT_TOKEN_TTL_MS + 1,
      0,
      -1,
      1.5,
      Number.NaN,
    ]) {
      expect(
        () =>
          validateFolderPolicy({
            defaultAccess: 'read_only',
            folderRules: [],
            engagementTokenTtlMs: ttl,
          }),
        `ttl=${ttl}`,
      ).toThrow(FolderPolicyError);
    }
  });

  it('accepts TTL at the contract boundaries', () => {
    for (const ttl of [
      MIN_ENGAGEMENT_TOKEN_TTL_MS,
      MAX_ENGAGEMENT_TOKEN_TTL_MS,
    ]) {
      expect(() =>
        validateFolderPolicy({
          defaultAccess: 'read_only',
          folderRules: [],
          engagementTokenTtlMs: ttl,
        }),
      ).not.toThrow();
    }
  });

  it('rejects duplicate `(folder, principalSet)` rules', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        folderRules: [
          { folder: 'src', access: 'read_only' },
          { folder: 'src', access: 'read_write' },
        ],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/duplicate/i);
  });

  it('allows two rules at the same folder when their principal sets differ', () => {
    const policy = validateFolderPolicy({
      defaultAccess: 'read_only',
      principals: [
        { principalId: 'agent-a', kind: 'agent' },
        { principalId: 'agent-b', kind: 'agent' },
      ],
      folderRules: [
        { folder: 'src', access: 'read_only' },
        {
          folder: 'src',
          access: 'read_write',
          appliesToPrincipalIds: ['agent-a'],
        },
      ],
      engagementTokenTtlMs: 60_000,
    });
    expect(policy.folderRules).toHaveLength(2);
  });

  it('rejects rules that reference undeclared principals', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        principals: [{ principalId: 'agent-a', kind: 'agent' }],
        folderRules: [
          {
            folder: 'src',
            access: 'read_write',
            appliesToPrincipalIds: ['ghost'],
          },
        ],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/unknown principalId/);
  });

  it('rejects principal-filtered rules when no principals are declared', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        folderRules: [
          {
            folder: 'src',
            access: 'read_write',
            appliesToPrincipalIds: ['agent-a'],
          },
        ],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/unknown principalId/);
  });

  it('rejects duplicate principals', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        principals: [
          { principalId: 'agent-a', kind: 'agent' },
          { principalId: 'agent-a', kind: 'operator' },
        ],
        folderRules: [],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/duplicate/);
  });

  it('rejects bad principal kinds', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        principals: [
          {
            principalId: 'agent-a',
            kind: 'admin' as unknown as 'agent',
          },
        ],
        folderRules: [],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(FolderPolicyError);
  });

  it('rejects non-string principal labels from the programmatic API', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        principals: [
          {
            principalId: 'agent-a',
            kind: 'agent',
            label: 42 as unknown as string,
          },
        ],
        folderRules: [],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/label must be a string/);
  });

  it('rejects malformed folder shapes at validation time', () => {
    for (const bad of ['/abs', '..', 'src/..', 'src\\win', 'C:/boot']) {
      expect(
        () =>
          validateFolderPolicy({
            defaultAccess: 'read_only',
            folderRules: [{ folder: bad, access: 'read_only' }],
            engagementTokenTtlMs: 60_000,
          }),
        `bad='${bad}'`,
      ).toThrow(FolderPolicyError);
    }
  });

  it('canonicalizes rule folders when accepted', () => {
    const p = validateFolderPolicy({
      defaultAccess: 'read_only',
      folderRules: [
        { folder: 'src/hoplon/', access: 'read_write' },
        { folder: '', access: 'read_only' },
      ],
      engagementTokenTtlMs: 60_000,
    });
    expect(p.folderRules.map((r) => r.folder).sort()).toEqual(['', 'src/hoplon']);
  });

  it('rejects overlapping principal-specific rules at the same folder', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        principals: [
          { principalId: 'agent-a', kind: 'agent' },
          { principalId: 'agent-b', kind: 'agent' },
        ],
        folderRules: [
          {
            folder: 'src',
            access: 'read_only',
            appliesToPrincipalIds: ['agent-a', 'agent-b'],
          },
          {
            folder: 'src',
            access: 'read_write',
            appliesToPrincipalIds: ['agent-a'],
          },
        ],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/overlaps an earlier principal-specific rule/);
  });

  it('is idempotent — re-running validate on the result returns an equal policy', () => {
    const first = validateFolderPolicy({
      defaultAccess: 'read_write',
      folderRules: [
        { folder: 'src', access: 'read_only' },
        {
          folder: 'src',
          access: 'read_write',
          appliesToPrincipalIds: ['a'],
        },
      ],
      principals: [{ principalId: 'a', kind: 'agent' }],
      engagementTokenTtlMs: 60_000,
    });
    const second = validateFolderPolicy(first);
    expect(second).toEqual(first);
  });

  it('freezes normalized rule and principal collections', () => {
    const policy = validateFolderPolicy({
      defaultAccess: 'read_only',
      folderRules: [{ folder: 'src', access: 'read_write' }],
      principals: [{ principalId: 'agent-a', kind: 'agent' }],
      engagementTokenTtlMs: 60_000,
    });
    expect(Object.isFrozen(policy.folderRules)).toBe(true);
    expect(Object.isFrozen(policy.principals ?? [])).toBe(true);
  });
});

describe('EngagementTokenBinding + EngagementTokenEnvelope shapes', () => {
  it('bindings and envelopes agree on every non-secret field', () => {
    const binding: EngagementTokenBinding = {
      projectId: 'dotfiles',
      folder: 'src',
      access: 'read_write',
      principalId: 'agent-a',
      issuedAtIso: '2026-04-23T00:00:00Z',
      expiresAtIso: '2026-04-23T00:15:00Z',
      nonce: 'server-private-nonce',
    };
    const envelope: EngagementTokenEnvelope = {
      token: 'opaque-token-string',
      projectId: binding.projectId,
      folder: binding.folder,
      access: binding.access,
      principalId: binding.principalId,
      issuedAtIso: binding.issuedAtIso,
      expiresAtIso: binding.expiresAtIso,
    };
    // The envelope must never carry the nonce — declared as absent from
    // the type. This is the structural guarantee agents rely on.
    expect(Object.prototype.hasOwnProperty.call(envelope, 'nonce')).toBe(false);
    expect(envelope.projectId).toBe(binding.projectId);
    expect(envelope.folder).toBe(binding.folder);
    expect(envelope.access).toBe(binding.access);
    expect(envelope.principalId).toBe(binding.principalId);
    expect(envelope.expiresAtIso).toBe(binding.expiresAtIso);
  });
});
