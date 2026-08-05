/**
 * t-087 hard-gate proof corpus: policy core.
 *
 * Covers path canonicalization, policy validation, and resolver precedence
 * against the shipped t-082 policy engine.
 */
import { describe, it, expect } from 'vitest';

import {
  canonicalizeProjectRelativeFolder,
  resolveFolderAccess,
  MAX_ENGAGEMENT_TOKEN_TTL_MS,
  MIN_ENGAGEMENT_TOKEN_TTL_MS,
  FolderPolicyError,
} from '../../src/hoplon/concurrency/projectPolicy.js';
import { validateFolderPolicy } from '../../src/hoplon/concurrency/projectPolicyValidation.js';
import { makePolicy } from './t087HardGateFixtures.js';

describe('t-087 / 1. canonicalization corpus', () => {
  const passCases: Array<[string, string]> = [
    ['', ''],
    ['src', 'src'],
    ['src/', 'src'],
    ['src/hoplon/launcher', 'src/hoplon/launcher'],
  ];
  for (const [raw, canon] of passCases) {
    it(`should-pass: canonicalizes '${raw}' -> '${canon}'`, () => {
      expect(canonicalizeProjectRelativeFolder(raw)).toEqual({
        ok: true,
        canonical: canon,
      });
    });
  }

  const failCases: Array<[unknown, string]> = [
    ['/abs/path', 'absolute_path'],
    ['C:/Users', 'windows_drive'],
    ['src\\hoplon', 'backslash'],
    ['..', 'parent_segment'],
    ['src/..', 'parent_segment'],
    ['.', 'dot_segment'],
    ['src//hoplon', 'empty_segment'],
    [42, 'not_a_string'],
    [null, 'not_a_string'],
    [undefined, 'not_a_string'],
  ];
  for (const [raw, reason] of failCases) {
    it(`should-fail: rejects '${String(raw)}' with reason '${reason}'`, () => {
      expect(canonicalizeProjectRelativeFolder(raw)).toEqual({
        ok: false,
        reason,
      });
    });
  }
});

describe('t-087 / 2. policy validation corpus', () => {
  it('should-fail: bad access enum surfaces invalid_mode', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'nope' as never,
        folderRules: [],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(FolderPolicyError);
  });

  it('should-fail: TTL below 1min band rejected', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        folderRules: [],
        engagementTokenTtlMs: MIN_ENGAGEMENT_TOKEN_TTL_MS - 1,
      }),
    ).toThrow(/invalid_ttl|engagementTokenTtlMs/);
  });

  it('should-fail: TTL above 24h band rejected', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        folderRules: [],
        engagementTokenTtlMs: MAX_ENGAGEMENT_TOKEN_TTL_MS + 1,
      }),
    ).toThrow(/invalid_ttl|engagementTokenTtlMs/);
  });

  it('should-fail: duplicate (folder, principals) pairs rejected explicitly', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        folderRules: [
          { folder: 'src', access: 'read_write' },
          { folder: 'src', access: 'read_only' },
        ],
        engagementTokenTtlMs: 60_000,
      }),
    ).toThrow(/duplicate_rule|duplicates/);
  });

  it('should-fail: unknown principal ref on a rule rejected', () => {
    expect(() =>
      validateFolderPolicy({
        defaultAccess: 'read_only',
        folderRules: [
          {
            folder: 'src',
            access: 'read_write',
            appliesToPrincipalIds: ['ghost'],
          },
        ],
        engagementTokenTtlMs: 60_000,
        principals: [{ principalId: 'agent-a', kind: 'agent' }],
      }),
    ).toThrow(/unknown_principal_ref|unknown principalId/);
  });
});

describe('t-087 / 3. resolver precedence corpus', () => {
  const policy = makePolicy();

  it('most-specific folder wins (src/hoplon beats src for non-targeted principal)', () => {
    const res = resolveFolderAccess(policy, 'src/hoplon/launcher', 'agent-b');
    expect(res.kind).toBe('matched');
    if (res.kind === 'matched') {
      expect(res.access).toBe('read_only');
      expect(res.matchedRuleFolder).toBe('src/hoplon');
    }
  });

  it('principal-specific beats principal-agnostic at equal specificity', () => {
    const res = resolveFolderAccess(policy, 'src', 'agent-a');
    expect(res.kind).toBe('matched');
    if (res.kind === 'matched') expect(res.access).toBe('read_only');
  });

  it('default_fallback fires when no rule covers canonical folder', () => {
    const res = resolveFolderAccess(policy, 'misc', 'agent-a');
    expect(res.kind).toBe('default_fallback');
    if (res.kind === 'default_fallback') {
      expect(res.access).toBe('read_only');
      expect(res.canonicalFolder).toBe('misc');
    }
  });

  it('none-mode rule at matching folder surfaces access:none', () => {
    const res = resolveFolderAccess(policy, 'secrets', 'agent-a');
    expect(res.kind).toBe('matched');
    if (res.kind === 'matched') expect(res.access).toBe('none');
  });
});
