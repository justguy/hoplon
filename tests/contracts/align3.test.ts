/**
 * ALIGN-3 — AuditViolation recs-spec alias normalisation tests.
 *
 * Proves:
 *   ALIGN-3-1: Input kind 'UNCONTRACTED_SYMBOL' parses successfully and
 *              the stored kind is 'out_of_scope_symbol'.
 *   ALIGN-3-2: Input kind 'UNCONTRACTED_SYMBOL' with missing required fields
 *              still rejects (the alias does not bypass validation).
 *   ALIGN-3-3: Input kind 'out_of_scope_symbol' (canonical) is unchanged.
 *   ALIGN-3-4: Input kind 'SCOPE_ESCAPE' is accepted as-is (shipped Phase 2
 *              canonical kind — no normalisation needed).
 *   ALIGN-3-5: Other shipped canonical kinds (Phase 1) are unaffected.
 *   ALIGN-3-6: Unknown kind still rejects (alias map does not widen the union).
 *   ALIGN-3-7: Downstream AuditResult BLOCK with UNCONTRACTED_SYMBOL alias
 *              parses, and the stored violation kind is canonical.
 */

import { describe, it, expect } from 'vitest';
import {
  AuditViolationSchema,
  AuditResultSchema,
} from '../../src/hoplon/contracts/audit.js';

// ---------------------------------------------------------------------------
// Shared fixture factory for out_of_scope_symbol fields (sans kind)
// ---------------------------------------------------------------------------

function outOfScopeSymbolFields() {
  return {
    path: 'src/auth.ts',
    symbolName: 'AuthService.constructor',
    nodeKind: 'method_definition',
    byteRange: [0, 100] as [number, number],
    sourceSlice: 'constructor() {}',
    expectedScope: { kind: 'symbols', symbols: ['login'] } as const,
    message: 'Symbol edited outside contracted scope.',
    correction: 'Revert changes to AuthService.constructor.',
  };
}

// ---------------------------------------------------------------------------
// ALIGN-3-1: UNCONTRACTED_SYMBOL alias → canonical 'out_of_scope_symbol'
// ---------------------------------------------------------------------------

describe('ALIGN-3-1: UNCONTRACTED_SYMBOL alias normalises to out_of_scope_symbol', () => {
  it('parses successfully when kind is UNCONTRACTED_SYMBOL', () => {
    const input = { kind: 'UNCONTRACTED_SYMBOL', ...outOfScopeSymbolFields() };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
  });

  it('stores kind as out_of_scope_symbol after normalisation', () => {
    const input = { kind: 'UNCONTRACTED_SYMBOL', ...outOfScopeSymbolFields() };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('out_of_scope_symbol');
    }
  });

  it('all non-kind fields pass through unchanged', () => {
    const fields = outOfScopeSymbolFields();
    const input = { kind: 'UNCONTRACTED_SYMBOL', ...fields };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success && result.data.kind === 'out_of_scope_symbol') {
      expect(result.data.path).toBe(fields.path);
      expect(result.data.symbolName).toBe(fields.symbolName);
      expect(result.data.nodeKind).toBe(fields.nodeKind);
      expect(result.data.byteRange).toEqual(fields.byteRange);
      expect(result.data.sourceSlice).toBe(fields.sourceSlice);
      expect(result.data.message).toBe(fields.message);
      expect(result.data.correction).toBe(fields.correction);
    }
  });
});

// ---------------------------------------------------------------------------
// ALIGN-3-2: UNCONTRACTED_SYMBOL alias does not bypass field validation
// ---------------------------------------------------------------------------

describe('ALIGN-3-2: UNCONTRACTED_SYMBOL alias still enforces required fields', () => {
  it('rejects when correction field is missing', () => {
    const { correction: _omitted, ...rest } = outOfScopeSymbolFields();
    const input = { kind: 'UNCONTRACTED_SYMBOL', ...rest };
    expect(AuditViolationSchema.safeParse(input).success).toBe(false);
  });

  it('rejects when symbolName is missing', () => {
    const { symbolName: _omitted, ...rest } = outOfScopeSymbolFields();
    const input = { kind: 'UNCONTRACTED_SYMBOL', ...rest };
    expect(AuditViolationSchema.safeParse(input).success).toBe(false);
  });

  it('rejects when path is missing', () => {
    const { path: _omitted, ...rest } = outOfScopeSymbolFields();
    const input = { kind: 'UNCONTRACTED_SYMBOL', ...rest };
    expect(AuditViolationSchema.safeParse(input).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ALIGN-3-3: Canonical 'out_of_scope_symbol' input unchanged
// ---------------------------------------------------------------------------

describe('ALIGN-3-3: Canonical out_of_scope_symbol input is unaffected', () => {
  it('parses canonical kind correctly', () => {
    const input = { kind: 'out_of_scope_symbol', ...outOfScopeSymbolFields() };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('out_of_scope_symbol');
    }
  });
});

// ---------------------------------------------------------------------------
// ALIGN-3-4: SCOPE_ESCAPE accepted as-is (shipped Phase 2 canonical kind)
// ---------------------------------------------------------------------------

describe('ALIGN-3-4: SCOPE_ESCAPE accepted as shipped Phase 2 canonical kind', () => {
  it('parses SCOPE_ESCAPE correctly', () => {
    const input = {
      kind: 'SCOPE_ESCAPE',
      path: 'src/auth.ts',
      escapingNodeKind: 'export_statement',
      parentNodeKind: 'class_declaration',
      byteRange: [100, 200],
      sourceSlice: 'export class AuthService {}',
      expectedScope: { kind: 'symbols', symbols: ['AuthService.login'] },
      message: 'Scope escape detected.',
      correction: 'Remove the escaping export statement.',
    };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('SCOPE_ESCAPE');
    }
  });
});

// ---------------------------------------------------------------------------
// ALIGN-3-5: Other Phase 1 canonical kinds are unaffected by normalisation
// ---------------------------------------------------------------------------

describe('ALIGN-3-5: Other canonical kinds pass through normalisation unchanged', () => {
  it('uncontracted_file parses correctly', () => {
    const input = {
      kind: 'uncontracted_file',
      path: 'src/new.ts',
      firstChangedLine: 1,
      sourceSlice: 'const x = 1;',
      message: 'File not in manifest.',
      correction: 'Remove changes to src/new.ts.',
    };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('uncontracted_file');
    }
  });

  it('parse_failure parses correctly', () => {
    const input = {
      kind: 'parse_failure',
      path: 'src/broken.ts',
      parseError: 'syntax error at line 5',
      nodeKind: null,
      message: 'File could not be parsed.',
      correction: 'Fix the syntax error at line 5.',
    };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('parse_failure');
    }
  });

  it('snapshot_missing parses correctly', () => {
    const input = {
      kind: 'snapshot_missing',
      path: 'src/auth.ts',
      snapshotRefId: 'a'.repeat(64),
      message: 'Snapshot not found.',
      correction: 'Re-create the snapshot before auditing.',
    };
    const result = AuditViolationSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.kind).toBe('snapshot_missing');
    }
  });
});

// ---------------------------------------------------------------------------
// ALIGN-3-6: Unknown kind rejects — alias map does not widen the union
// ---------------------------------------------------------------------------

describe('ALIGN-3-6: Unknown kind rejects — alias normalisation does not widen the union', () => {
  it('rejects kind UNKNOWN_SYMBOL', () => {
    const input = { kind: 'UNKNOWN_SYMBOL', ...outOfScopeSymbolFields() };
    expect(AuditViolationSchema.safeParse(input).success).toBe(false);
  });

  it('rejects kind uncontracted_symbol (wrong case — not an alias)', () => {
    const input = { kind: 'uncontracted_symbol', ...outOfScopeSymbolFields() };
    expect(AuditViolationSchema.safeParse(input).success).toBe(false);
  });

  it('rejects kind UNCONTRACTED_FILE (not a defined alias)', () => {
    // Only UNCONTRACTED_SYMBOL is aliased; UNCONTRACTED_FILE is not.
    const input = {
      kind: 'UNCONTRACTED_FILE',
      path: 'src/new.ts',
      firstChangedLine: 1,
      sourceSlice: 'const x = 1;',
      message: 'File not in manifest.',
      correction: 'Remove changes.',
    };
    expect(AuditViolationSchema.safeParse(input).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ALIGN-3-7: AuditResult BLOCK with UNCONTRACTED_SYMBOL alias in violations
// ---------------------------------------------------------------------------

describe('ALIGN-3-7: AuditResult BLOCK parses with UNCONTRACTED_SYMBOL alias', () => {
  it('parses successfully and stored violation kind is canonical', () => {
    const blockResult = {
      status: 'BLOCK',
      auditSchemaVersion: 1,
      correlationId: 'corr-align3-test',
      violations: [
        { kind: 'UNCONTRACTED_SYMBOL', ...outOfScopeSymbolFields() },
      ],
    };
    const result = AuditResultSchema.safeParse(blockResult);
    expect(result.success).toBe(true);
    if (result.success && result.data.status === 'BLOCK') {
      expect(result.data.violations).toHaveLength(1);
      expect(result.data.violations[0].kind).toBe('out_of_scope_symbol');
    }
  });
});
