/**
 * Contract tests specifically for AuditViolation — correction field requirement.
 *
 * Proves all 4 variants require correction field; rejects when missing.
 * (Separate from the broader audit.test.ts to keep focused.)
 */

import { describe, it, expect } from 'vitest';
import { AuditViolationSchema } from '../../src/hoplon/contracts/audit.js';

describe('AuditViolation — correction field mandatory on all variants', () => {
  it('out_of_scope_symbol rejects when correction missing', () => {
    const violation = {
      kind: 'out_of_scope_symbol',
      path: 'src/auth.ts',
      symbolName: 'AuthService.constructor',
      nodeKind: 'method_definition',
      byteRange: [0, 100],
      sourceSlice: 'constructor() {}',
      expectedScope: { kind: 'symbols', symbols: ['login'] },
      message: 'out of scope',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('uncontracted_file rejects when correction missing', () => {
    const violation = {
      kind: 'uncontracted_file',
      path: 'src/new.ts',
      firstChangedLine: 1,
      sourceSlice: 'const x = 1;',
      message: 'uncontracted file',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('parse_failure rejects when correction missing', () => {
    const violation = {
      kind: 'parse_failure',
      path: 'src/broken.ts',
      parseError: 'syntax error',
      nodeKind: null,
      message: 'parse failed',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('snapshot_missing rejects when correction missing', () => {
    const violation = {
      kind: 'snapshot_missing',
      path: 'src/auth.ts',
      snapshotRefId: 'a'.repeat(64),
      message: 'snapshot not found',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('out_of_scope_symbol accepts when correction present', () => {
    const violation = {
      kind: 'out_of_scope_symbol',
      path: 'src/auth.ts',
      symbolName: 'AuthService.constructor',
      nodeKind: 'method_definition',
      byteRange: [0, 100],
      sourceSlice: 'constructor() {}',
      expectedScope: { kind: 'symbols', symbols: ['login'] },
      message: 'out of scope',
      correction: 'Revert and confine to login.',
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-10 through SV2-18: Phase 2 variants — correction field mandatory
// ---------------------------------------------------------------------------

describe('SV2-10 through SV2-18: Phase 2 variants — correction field mandatory', () => {
  it('SV2-10: SCOPE_ESCAPE rejects when correction missing', () => {
    const violation = {
      kind: 'SCOPE_ESCAPE',
      path: 'src/auth.ts',
      escapingNodeKind: 'export_statement',
      parentNodeKind: 'class_declaration',
      byteRange: [100, 200],
      sourceSlice: 'export class AuthService {}',
      expectedScope: { kind: 'symbols', symbols: ['AuthService.login'] },
      message: 'scope escape detected',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-11: STRUCTURAL_CORRUPTION rejects when correction missing', () => {
    const violation = {
      kind: 'STRUCTURAL_CORRUPTION',
      path: 'src/auth.ts',
      corruptedNodeKind: 'ERROR',
      byteRange: [50, 75],
      sourceSlice: 'function foo( {',
      message: 'structural corruption detected',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-12: PATH_ESCAPE rejects when correction missing', () => {
    const violation = {
      kind: 'PATH_ESCAPE',
      path: '../../../etc/passwd',
      resolvedPath: '/etc/passwd',
      sandboxRoot: '/home/user/project',
      message: 'path escape detected',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-13: SIGNATURE_MISMATCH rejects when correction missing', () => {
    const violation = {
      kind: 'SIGNATURE_MISMATCH',
      path: 'src/auth.ts',
      symbol: 'AuthService.login',
      expected: '(username: string, password: string): Promise<User>',
      actual: '(username: string): Promise<User>',
      message: 'signature mismatch detected',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-14: SIGNATURE_UNCERTAIN rejects when correction missing', () => {
    const violation = {
      kind: 'SIGNATURE_UNCERTAIN',
      path: 'src/auth.ts',
      symbol: 'AuthService.find',
      note: 'Generic type — deferred to Phase 3.',
      message: 'signature uncertain',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-15: TARGET_NOT_FOUND rejects when correction missing', () => {
    const violation = {
      kind: 'TARGET_NOT_FOUND',
      path: 'src/auth.ts',
      symbolName: 'AuthService.logout',
      manifestIntent: 'modify',
      message: 'target not found',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-16: DUPLICATE_TARGET rejects when correction missing', () => {
    const violation = {
      kind: 'DUPLICATE_TARGET',
      path: 'src/auth.ts',
      symbolName: 'AuthService.login',
      manifestIntent: 'create',
      existingByteRange: [100, 250],
      message: 'duplicate target detected',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-17: IMPORT_TARGET_NOT_FOUND rejects when correction missing', () => {
    const violation = {
      kind: 'IMPORT_TARGET_NOT_FOUND',
      path: 'src/auth.ts',
      importPath: './helpers/crypto',
      fromFile: 'src/auth.ts',
      message: 'import target not found',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-17b: IMPORT_SYMBOL_NOT_EXPORTED rejects when correction missing', () => {
    const violation = {
      kind: 'IMPORT_SYMBOL_NOT_EXPORTED',
      path: 'src/auth.ts',
      importPath: './helpers/crypto',
      symbol: 'hashPassword',
      availableExports: ['encrypt'],
      message: 'import symbol not exported',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });

  it('SV2-18: IMPORT_ALIAS_UNRESOLVED rejects when correction missing', () => {
    const violation = {
      kind: 'IMPORT_ALIAS_UNRESOLVED',
      path: 'src/auth.ts',
      importPath: '@/helpers/crypto',
      note: 'Path alias resolution requires tsconfig — deferred to Phase 3.',
      message: 'import alias unresolved',
      // correction intentionally omitted
    };
    expect(AuditViolationSchema.safeParse(violation).success).toBe(false);
  });
});
