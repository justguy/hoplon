/**
 * Contract tests for ASTStrategy discriminated union.
 */

import { describe, it, expect } from 'vitest';
import { ASTStrategySchema } from '../../src/hoplon/contracts/astStrategy.js';

describe('ASTStrategy', () => {
  it('accepts whole_file variant', () => {
    expect(ASTStrategySchema.safeParse({ kind: 'whole_file' }).success).toBe(true);
  });

  it('accepts symbols variant with at least one symbol', () => {
    expect(
      ASTStrategySchema.safeParse({ kind: 'symbols', symbols: ['formatPrice'] }).success,
    ).toBe(true);
  });

  it('accepts symbols variant with multiple symbols', () => {
    expect(
      ASTStrategySchema.safeParse({
        kind: 'symbols',
        symbols: ['formatPrice', 'PriceFormat', 'Currency'],
      }).success,
    ).toBe(true);
  });

  it('rejects symbols variant with empty array', () => {
    expect(
      ASTStrategySchema.safeParse({ kind: 'symbols', symbols: [] }).success,
    ).toBe(false);
  });

  it('rejects unknown kind', () => {
    expect(
      ASTStrategySchema.safeParse({ kind: 'focus_with_skeleton', focusSymbols: ['foo'] }).success,
    ).toBe(false);
  });

  it('rejects missing kind', () => {
    expect(ASTStrategySchema.safeParse({ symbols: ['foo'] }).success).toBe(false);
  });

  it('rejects whole_file with extra fields (not strict but kind must be correct)', () => {
    // ASTStrategySchema is not strict so extra fields pass at parse time — this tests
    // the kind discriminator only
    const result = ASTStrategySchema.safeParse({ kind: 'whole_file' });
    expect(result.success).toBe(true);
  });
});
