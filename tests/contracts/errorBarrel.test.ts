/**
 * ALIGN-5 smoke test — HoplonError subclasses reachable from public barrel.
 *
 * Verifies that all 5 error classes are exported from src/index.ts so that
 * cross-package instanceof checks work correctly.
 *
 * Assertions per ALIGN-5 proof criteria:
 *   1. Each class is typeof === 'function' (constructor callable)
 *   2. A thrown child instance is instanceof HoplonError (prototype chain intact)
 */

import { describe, it, expect } from 'vitest';
import {
  HoplonError,
  AdapterError,
  EngineError,
  SemanticError,
  ValidationError,
} from '../../src/index.js';

describe('ALIGN-5: error classes exported from public barrel', () => {
  it('HoplonError is a constructor (typeof === function)', () => {
    expect(typeof HoplonError).toBe('function');
  });

  it('AdapterError is a constructor (typeof === function)', () => {
    expect(typeof AdapterError).toBe('function');
  });

  it('EngineError is a constructor (typeof === function)', () => {
    expect(typeof EngineError).toBe('function');
  });

  it('SemanticError is a constructor (typeof === function)', () => {
    expect(typeof SemanticError).toBe('function');
  });

  it('ValidationError is a constructor (typeof === function)', () => {
    expect(typeof ValidationError).toBe('function');
  });

  it('thrown AdapterError is instanceof HoplonError (cross-package instanceof chain)', () => {
    const err = new AdapterError({
      kind: 'fs_read_failed',
      engineId: 'align-5-test',
      correlationId: 'smoke-001',
    });
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(AdapterError);
  });

  it('thrown EngineError is instanceof HoplonError', () => {
    const err = new EngineError({
      kind: 'missing_adapter',
      engineId: 'align-5-test',
      correlationId: 'smoke-002',
    });
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(EngineError);
  });

  it('thrown SemanticError is instanceof HoplonError', () => {
    const err = new SemanticError({
      kind: 'snapshot_missing',
      engineId: 'align-5-test',
      correlationId: 'smoke-003',
    });
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(SemanticError);
  });

  it('thrown ValidationError is instanceof HoplonError', () => {
    const err = new ValidationError({
      kind: 'path_traversal',
      engineId: 'align-5-test',
      correlationId: 'smoke-004',
    });
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(ValidationError);
  });
});
