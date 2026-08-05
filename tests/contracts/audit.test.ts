/**
 * Contract tests for AuditViolation (all 4 kinds) and AuditResult.
 *
 * A3.1 updates:
 * - AuditResult PASS/BLOCK now carry auditSchemaVersion: 1 and correlationId
 * - All violation variants already had correction (no change needed)
 *
 * hcr-002 updates:
 * - AuditViolationOutOfScopeSymbol sourceSlice is never truncated (the old
 *   .max(4096) cap is gone — agent-facing evidence carries the full slice)
 * - optional changeType ('added' | 'removed' | 'modified') carries the
 *   diff fact from the baseline comparison
 *
 * Key checks:
 * - Each kind accepts its valid shape
 * - Each kind rejects missing required fields (especially `correction`)
 * - Discriminated union rejects unknown kinds
 * - PASS/BLOCK union now requires auditSchemaVersion and correlationId
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  AuditViolationSchema,
  AuditViolationUnionSchema,
  AuditResultSchema,
} from '../../src/hoplon/contracts/audit.js';

// ---------------------------------------------------------------------------
// Shared base for violations that need correction/message
// ---------------------------------------------------------------------------

const VALID_OUT_OF_SCOPE = {
  kind: 'out_of_scope_symbol' as const,
  path: 'src/auth.ts',
  symbolName: 'AuthService.constructor',
  nodeKind: 'method_definition',
  byteRange: [100, 250] as [number, number],
  sourceSlice: 'constructor() { this.db = new DB(); }',
  expectedScope: { kind: 'symbols' as const, symbols: ['AuthService.login'] },
  message: 'Edit modified AuthService.constructor, which is not in the contracted scope.',
  correction: 'Revert the modification to AuthService.constructor and confine your edits to AuthService.login.',
};

const VALID_UNCONTRACTED_FILE = {
  kind: 'uncontracted_file' as const,
  path: 'src/utils/secret.ts',
  firstChangedLine: 42,
  sourceSlice: 'export const SECRET = "leaked";',
  message: 'File src/utils/secret.ts was modified but is not in the contracted manifest.',
  correction: 'Revert all changes to src/utils/secret.ts — it is not in the writable manifest.',
};

const VALID_PARSE_FAILURE = {
  kind: 'parse_failure' as const,
  path: 'src/broken.ts',
  parseError: 'Unexpected token at line 5',
  nodeKind: null,
  message: 'src/broken.ts could not be parsed by the tree-sitter grammar.',
  correction: 'Fix the syntax error in src/broken.ts before resubmitting.',
};

const VALID_SNAPSHOT_MISSING = {
  kind: 'snapshot_missing' as const,
  path: 'src/auth.ts',
  snapshotRefId: 'a'.repeat(64),
  message: 'Snapshot a...a does not exist in the snapshot store.',
  correction: 'Re-run createSnapshot before calling auditDiff.',
};

// ---------------------------------------------------------------------------
// AuditViolation — out_of_scope_symbol
// ---------------------------------------------------------------------------

describe('AuditViolation — out_of_scope_symbol', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_OUT_OF_SCOPE).success).toBe(true);
  });

  it('accepts with truncated: true', () => {
    expect(
      AuditViolationSchema.safeParse({ ...VALID_OUT_OF_SCOPE, truncated: true }).success,
    ).toBe(true);
  });

  it('rejects missing correction', () => {
    const { correction: _c, ...withoutCorrection } = VALID_OUT_OF_SCOPE;
    expect(AuditViolationSchema.safeParse(withoutCorrection).success).toBe(false);
  });

  it('rejects missing message', () => {
    const { message: _m, ...withoutMessage } = VALID_OUT_OF_SCOPE;
    expect(AuditViolationSchema.safeParse(withoutMessage).success).toBe(false);
  });

  it('rejects empty correction', () => {
    expect(
      AuditViolationSchema.safeParse({ ...VALID_OUT_OF_SCOPE, correction: '' }).success,
    ).toBe(false);
  });

  it('rejects missing symbolName', () => {
    const { symbolName: _s, ...without } = VALID_OUT_OF_SCOPE;
    expect(AuditViolationSchema.safeParse(without).success).toBe(false);
  });

  it('accepts sourceSlice exceeding 4096 characters (never truncated — hcr-002)', () => {
    expect(
      AuditViolationSchema.safeParse({
        ...VALID_OUT_OF_SCOPE,
        sourceSlice: 'x'.repeat(4097),
      }).success,
    ).toBe(true);
  });

  it('accepts each changeType value and rejects unknown ones', () => {
    for (const changeType of ['added', 'removed', 'modified']) {
      expect(
        AuditViolationSchema.safeParse({ ...VALID_OUT_OF_SCOPE, changeType }).success,
      ).toBe(true);
    }
    expect(
      AuditViolationSchema.safeParse({
        ...VALID_OUT_OF_SCOPE,
        changeType: 'renamed',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuditViolation — uncontracted_file
// ---------------------------------------------------------------------------

describe('AuditViolation — uncontracted_file', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_UNCONTRACTED_FILE).success).toBe(true);
  });

  it('rejects missing correction', () => {
    const { correction: _c, ...without } = VALID_UNCONTRACTED_FILE;
    expect(AuditViolationSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing message', () => {
    const { message: _m, ...without } = VALID_UNCONTRACTED_FILE;
    expect(AuditViolationSchema.safeParse(without).success).toBe(false);
  });

  it('rejects negative firstChangedLine', () => {
    expect(
      AuditViolationSchema.safeParse({
        ...VALID_UNCONTRACTED_FILE,
        firstChangedLine: -1,
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuditViolation — parse_failure
// ---------------------------------------------------------------------------

describe('AuditViolation — parse_failure', () => {
  it('accepts valid shape with null nodeKind', () => {
    expect(AuditViolationSchema.safeParse(VALID_PARSE_FAILURE).success).toBe(true);
  });

  it('accepts valid shape with non-null nodeKind', () => {
    expect(
      AuditViolationSchema.safeParse({
        ...VALID_PARSE_FAILURE,
        nodeKind: 'function_declaration',
      }).success,
    ).toBe(true);
  });

  it('rejects missing correction', () => {
    const { correction: _c, ...without } = VALID_PARSE_FAILURE;
    expect(AuditViolationSchema.safeParse(without).success).toBe(false);
  });

  it('rejects empty parseError', () => {
    expect(
      AuditViolationSchema.safeParse({ ...VALID_PARSE_FAILURE, parseError: '' }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuditViolation — snapshot_missing
// ---------------------------------------------------------------------------

describe('AuditViolation — snapshot_missing', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_SNAPSHOT_MISSING).success).toBe(true);
  });

  it('rejects missing correction', () => {
    const { correction: _c, ...without } = VALID_SNAPSHOT_MISSING;
    expect(AuditViolationSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing snapshotRefId', () => {
    const { snapshotRefId: _s, ...without } = VALID_SNAPSHOT_MISSING;
    expect(AuditViolationSchema.safeParse(without).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuditViolation — unknown kind rejected
// ---------------------------------------------------------------------------

describe('AuditViolation — discriminator', () => {
  it('rejects unknown kind', () => {
    expect(
      AuditViolationSchema.safeParse({
        kind: 'some_future_kind',
        path: 'src/x.ts',
        message: 'x',
        correction: 'y',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuditResult — now carries auditSchemaVersion: 1 and correlationId (H8, H11)
// ---------------------------------------------------------------------------

describe('AuditResult', () => {
  it('accepts PASS with checked count, auditSchemaVersion, correlationId, and nullable auditRef', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 3,
        auditSchemaVersion: 1,
        correlationId: 'corr-123',
        auditRef: null,
      }).success,
    ).toBe(true);
  });

  it('rejects PASS without auditSchemaVersion', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 3,
        correlationId: 'corr-123',
      }).success,
    ).toBe(false);
  });

  it('rejects PASS without correlationId', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 3,
        auditSchemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects PASS without checked', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        auditSchemaVersion: 1,
        correlationId: 'corr-123',
      }).success,
    ).toBe(false);
  });

  it('rejects PASS with auditSchemaVersion: 2 (future version)', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'PASS',
        checked: 3,
        auditSchemaVersion: 2,
        correlationId: 'corr-123',
      }).success,
    ).toBe(false);
  });

  it('accepts BLOCK with violations, auditSchemaVersion, correlationId, and auditRef', () => {
    const result = AuditResultSchema.safeParse({
      status: 'BLOCK',
      violations: [VALID_SNAPSHOT_MISSING],
      auditSchemaVersion: 1,
      correlationId: 'corr-456',
      auditRef: 'audit-456',
    });
    expect(result.success).toBe(true);
  });

  it('rejects BLOCK without auditSchemaVersion', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'BLOCK',
        violations: [VALID_SNAPSHOT_MISSING],
        correlationId: 'corr-456',
      }).success,
    ).toBe(false);
  });

  it('rejects BLOCK without correlationId', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'BLOCK',
        violations: [VALID_SNAPSHOT_MISSING],
        auditSchemaVersion: 1,
      }).success,
    ).toBe(false);
  });

  it('rejects BLOCK with empty violations', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'BLOCK',
        violations: [],
        auditSchemaVersion: 1,
        correlationId: 'corr-456',
      }).success,
    ).toBe(false);
  });

  it('rejects unknown status', () => {
    expect(
      AuditResultSchema.safeParse({
        status: 'WARN',
        checked: 1,
        auditSchemaVersion: 1,
        correlationId: 'corr-123',
      }).success,
    ).toBe(false);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(AuditResultSchema, 'AuditResult');
    expect(jsonSchema).toBeDefined();
    expect(JSON.stringify(jsonSchema).length).toBeGreaterThan(100);
  });
});

// ---------------------------------------------------------------------------
// SV2 — Phase 2 additive violation variants
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// SV2-1: SCOPE_ESCAPE parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_SCOPE_ESCAPE = {
  kind: 'SCOPE_ESCAPE' as const,
  path: 'src/auth.ts',
  escapingNodeKind: 'export_statement',
  parentNodeKind: 'class_declaration',
  byteRange: [100, 200] as [number, number],
  sourceSlice: 'export class AuthService {}',
  expectedScope: { kind: 'symbols' as const, symbols: ['AuthService.login'] },
  message: 'export_statement in class_declaration escapes contracted scope.',
  correction: 'Remove the export_statement or add the class to the manifest scope.',
};

describe('SV2-1: AuditViolation — SCOPE_ESCAPE', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_SCOPE_ESCAPE).success).toBe(true);
  });

  it('accepts with truncated: true', () => {
    expect(
      AuditViolationSchema.safeParse({ ...VALID_SCOPE_ESCAPE, truncated: true }).success,
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-2: STRUCTURAL_CORRUPTION parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_STRUCTURAL_CORRUPTION = {
  kind: 'STRUCTURAL_CORRUPTION' as const,
  path: 'src/auth.ts',
  corruptedNodeKind: 'ERROR',
  byteRange: [50, 75] as [number, number],
  sourceSlice: 'function foo( {',
  message: 'ERROR node detected at byte 50-75 — structural unit is malformed.',
  correction: 'Fix the syntax error at the reported byte range before resubmitting.',
};

describe('SV2-2: AuditViolation — STRUCTURAL_CORRUPTION', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_STRUCTURAL_CORRUPTION).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-3: PATH_ESCAPE parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_PATH_ESCAPE = {
  kind: 'PATH_ESCAPE' as const,
  path: '../../../etc/passwd',
  resolvedPath: '/etc/passwd',
  sandboxRoot: '/home/user/project',
  message: 'Path ../../../etc/passwd resolves outside the sandbox root.',
  correction: 'Use a path that stays within the sandbox root /home/user/project.',
};

describe('SV2-3: AuditViolation — PATH_ESCAPE', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_PATH_ESCAPE).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-4: SIGNATURE_MISMATCH parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_SIGNATURE_MISMATCH = {
  kind: 'SIGNATURE_MISMATCH' as const,
  path: 'src/auth.ts',
  symbol: 'AuthService.login',
  expected: '(username: string, password: string): Promise<User>',
  actual: '(username: string): Promise<User>',
  message: 'AuthService.login signature does not match the declared contract.',
  correction: 'Add the missing password parameter to AuthService.login.',
};

describe('SV2-4: AuditViolation — SIGNATURE_MISMATCH', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_SIGNATURE_MISMATCH).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-5: SIGNATURE_UNCERTAIN parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_SIGNATURE_UNCERTAIN = {
  kind: 'SIGNATURE_UNCERTAIN' as const,
  path: 'src/auth.ts',
  symbol: 'AuthService.find',
  note: 'Generic type parameter T<U> — defer to ts-morph for structural comparison (Phase 3).',
  message: 'AuthService.find has generic signature; comparison deferred.',
  correction: 'Verify the generic signature manually; structural check requires Phase 3 ts-morph.',
};

describe('SV2-5: AuditViolation — SIGNATURE_UNCERTAIN', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_SIGNATURE_UNCERTAIN).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-6: TARGET_NOT_FOUND parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_TARGET_NOT_FOUND = {
  kind: 'TARGET_NOT_FOUND' as const,
  path: 'src/auth.ts',
  symbolName: 'AuthService.logout',
  manifestIntent: 'modify' as const,
  message: 'AuthService.logout does not exist in the snapshot but manifest intent is modify.',
  correction: "Change manifest intent to 'create' or ensure AuthService.logout exists in the snapshot.",
};

describe('SV2-6: AuditViolation — TARGET_NOT_FOUND', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_TARGET_NOT_FOUND).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-7: DUPLICATE_TARGET parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_DUPLICATE_TARGET = {
  kind: 'DUPLICATE_TARGET' as const,
  path: 'src/auth.ts',
  symbolName: 'AuthService.login',
  manifestIntent: 'create' as const,
  existingByteRange: [100, 250] as [number, number],
  message: 'AuthService.login already exists in the snapshot but manifest intent is create.',
  correction: "Change manifest intent to 'modify' or remove the existing AuthService.login first.",
};

describe('SV2-7: AuditViolation — DUPLICATE_TARGET', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_DUPLICATE_TARGET).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-8: IMPORT_TARGET_NOT_FOUND parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_IMPORT_TARGET_NOT_FOUND = {
  kind: 'IMPORT_TARGET_NOT_FOUND' as const,
  path: 'src/auth.ts',
  importPath: './helpers/crypto',
  fromFile: 'src/auth.ts',
  message: 'src/auth.ts imports ./helpers/crypto which does not exist in the snapshot.',
  correction: 'Create helpers/crypto.ts or correct the import path in src/auth.ts.',
};

describe('SV2-8: AuditViolation — IMPORT_TARGET_NOT_FOUND', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_IMPORT_TARGET_NOT_FOUND).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-9a: IMPORT_SYMBOL_NOT_EXPORTED parses a valid fixture
// SV2-9b: IMPORT_ALIAS_UNRESOLVED parses a valid fixture
// ---------------------------------------------------------------------------

const VALID_IMPORT_SYMBOL_NOT_EXPORTED = {
  kind: 'IMPORT_SYMBOL_NOT_EXPORTED' as const,
  path: 'src/auth.ts',
  importPath: './helpers/crypto',
  symbol: 'hashPassword',
  availableExports: ['encrypt', 'decrypt'],
  message: 'src/auth.ts imports hashPassword from ./helpers/crypto, which is not exported.',
  correction: 'Export hashPassword from ./helpers/crypto or import one of: encrypt, decrypt.',
};

const VALID_IMPORT_ALIAS_UNRESOLVED = {
  kind: 'IMPORT_ALIAS_UNRESOLVED' as const,
  path: 'src/auth.ts',
  importPath: '@/helpers/crypto',
  note: 'Path alias resolution requires tsconfig — deferred to Phase 3.',
  message: 'src/auth.ts uses path alias @/helpers/crypto which cannot be resolved in Phase 2.',
  correction: 'Use a relative import path, or wait for Phase 3 tsconfig-aware resolution.',
};

describe('SV2-9a: AuditViolation — IMPORT_SYMBOL_NOT_EXPORTED', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_IMPORT_SYMBOL_NOT_EXPORTED).success).toBe(true);
  });

  it('accepts with empty availableExports array', () => {
    expect(
      AuditViolationSchema.safeParse({
        ...VALID_IMPORT_SYMBOL_NOT_EXPORTED,
        availableExports: [],
      }).success,
    ).toBe(true);
  });
});

describe('SV2-9b: AuditViolation — IMPORT_ALIAS_UNRESOLVED', () => {
  it('accepts valid shape', () => {
    expect(AuditViolationSchema.safeParse(VALID_IMPORT_ALIAS_UNRESOLVED).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-19: Phase 1's 4 canonical kinds still parse (regression guard)
// ---------------------------------------------------------------------------

describe('SV2-19: Phase 1 canonical kinds still parse', () => {
  it('out_of_scope_symbol round-trips', () => {
    expect(AuditViolationSchema.safeParse(VALID_OUT_OF_SCOPE).success).toBe(true);
  });

  it('uncontracted_file round-trips', () => {
    expect(AuditViolationSchema.safeParse(VALID_UNCONTRACTED_FILE).success).toBe(true);
  });

  it('parse_failure round-trips', () => {
    expect(AuditViolationSchema.safeParse(VALID_PARSE_FAILURE).success).toBe(true);
  });

  it('snapshot_missing round-trips', () => {
    expect(AuditViolationSchema.safeParse(VALID_SNAPSHOT_MISSING).success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// SV2-20: Non-union kind rejects
// ---------------------------------------------------------------------------

describe('SV2-20: Non-union kind rejects', () => {
  it('rejects FAKE_KIND', () => {
    expect(
      AuditViolationSchema.safeParse({
        kind: 'FAKE_KIND',
        path: 'src/x.ts',
        message: 'x',
        correction: 'y',
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SV2-21: Exhaustive kind count — union has exactly 14 variants
// ---------------------------------------------------------------------------

describe('SV2-21: Exhaustive kind count', () => {
  it('AuditViolationSchema has exactly 14 variants (4 Phase 1 + 10 Phase 2)', () => {
    // AuditViolationSchema is wrapped in z.preprocess for alias normalisation;
    // structural inspection (optionsMap) uses the exported raw union.
    const optionsMap = AuditViolationUnionSchema.optionsMap as Map<string, unknown>;
    expect(optionsMap.size).toBe(14);

    // Verify all expected kinds are present
    const expectedKinds = [
      // Phase 1 canonical
      'out_of_scope_symbol',
      'uncontracted_file',
      'parse_failure',
      'snapshot_missing',
      // Phase 2 additive
      'SCOPE_ESCAPE',
      'STRUCTURAL_CORRUPTION',
      'PATH_ESCAPE',
      'SIGNATURE_MISMATCH',
      'SIGNATURE_UNCERTAIN',
      'TARGET_NOT_FOUND',
      'DUPLICATE_TARGET',
      'IMPORT_TARGET_NOT_FOUND',
      'IMPORT_SYMBOL_NOT_EXPORTED',
      'IMPORT_ALIAS_UNRESOLVED',
    ];
    for (const kind of expectedKinds) {
      expect(optionsMap.has(kind)).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// SV2-22: H13 violation_kinds array is closed-union strings
// ---------------------------------------------------------------------------

describe('SV2-22: H13 violation_kinds closed-union string array', () => {
  it('extracts violationKinds as closed-union strings from a BLOCK result with all new kinds', () => {
    const violations = [
      VALID_SCOPE_ESCAPE,
      VALID_STRUCTURAL_CORRUPTION,
      VALID_PATH_ESCAPE,
      VALID_SIGNATURE_MISMATCH,
      VALID_SIGNATURE_UNCERTAIN,
      VALID_TARGET_NOT_FOUND,
      VALID_DUPLICATE_TARGET,
      VALID_IMPORT_TARGET_NOT_FOUND,
      VALID_IMPORT_SYMBOL_NOT_EXPORTED,
      VALID_IMPORT_ALIAS_UNRESOLVED,
    ];

    const blockResult = {
      status: 'BLOCK' as const,
      violations,
      auditSchemaVersion: 1 as const,
      correlationId: 'corr-sv2-22',
    };

    const parsed = AuditResultSchema.safeParse(blockResult);
    expect(parsed.success).toBe(true);

    if (parsed.success && parsed.data.status === 'BLOCK') {
      const violationKinds = parsed.data.violations.map((v) => v.kind);

      // H13: violation_kinds must be an array of closed-union strings
      expect(Array.isArray(violationKinds)).toBe(true);
      expect(violationKinds.length).toBe(10);

      // Each kind is a non-null, non-numeric string
      for (const kind of violationKinds) {
        expect(typeof kind).toBe('string');
        expect(kind).toBeTruthy();
        expect(typeof kind).not.toBe('number');
      }

      // Exact set of Phase 2 kinds
      const expectedKinds = [
        'SCOPE_ESCAPE',
        'STRUCTURAL_CORRUPTION',
        'PATH_ESCAPE',
        'SIGNATURE_MISMATCH',
        'SIGNATURE_UNCERTAIN',
        'TARGET_NOT_FOUND',
        'DUPLICATE_TARGET',
        'IMPORT_TARGET_NOT_FOUND',
        'IMPORT_SYMBOL_NOT_EXPORTED',
        'IMPORT_ALIAS_UNRESOLVED',
      ];
      expect(violationKinds).toEqual(expectedKinds);
    }
  });
});
