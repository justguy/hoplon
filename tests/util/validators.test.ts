/**
 * Tests for validateCorrelationId and validateRunId utilities.
 *
 * Proves:
 * - Both reject empty strings
 * - Both reject whitespace-only strings
 * - Both reject strings exceeding 256 characters
 * - Both accept valid strings
 * - Both throw ValidationError with sentinel values for engineId/correlationId
 */

import { describe, it, expect } from 'vitest';
import { validateCorrelationId, validateRunId } from '../../src/hoplon/util/validators.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// validateCorrelationId
// ---------------------------------------------------------------------------

describe('validateCorrelationId', () => {
  it('accepts a simple UUID-style correlationId', () => {
    expect(() => validateCorrelationId('corr-abc-123-def')).not.toThrow();
  });

  it('accepts a complex correlationId', () => {
    expect(() => validateCorrelationId('corr_2026-04-12T22:00:00.000Z_project-A')).not.toThrow();
  });

  it('accepts a single character correlationId', () => {
    expect(() => validateCorrelationId('x')).not.toThrow();
  });

  it('accepts a 256-character correlationId (at limit)', () => {
    expect(() => validateCorrelationId('a'.repeat(256))).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateCorrelationId('')).toThrow(ValidationError);
    try {
      validateCorrelationId('');
    } catch (err) {
      expect((err as ValidationError).kind).toBe('invalid_correlation_id');
    }
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateCorrelationId('   ')).toThrow(ValidationError);
    try {
      validateCorrelationId('   ');
    } catch (err) {
      expect((err as ValidationError).kind).toBe('invalid_correlation_id');
    }
  });

  it('rejects tab-only string', () => {
    expect(() => validateCorrelationId('\t\t')).toThrow(ValidationError);
  });

  it('rejects string exceeding 256 characters', () => {
    expect(() => validateCorrelationId('a'.repeat(257))).toThrow(ValidationError);
    try {
      validateCorrelationId('a'.repeat(257));
    } catch (err) {
      expect((err as ValidationError).kind).toBe('invalid_correlation_id');
    }
  });

  it('uses sentinel engineId and correlationId in error', () => {
    try {
      validateCorrelationId('');
    } catch (err) {
      expect((err as ValidationError).engineId).toBe('validator');
      expect((err as ValidationError).correlationId).toBe('validator');
    }
  });
});

// ---------------------------------------------------------------------------
// validateRunId
// ---------------------------------------------------------------------------

describe('validateRunId', () => {
  it('accepts a simple UUID-style runId', () => {
    expect(() => validateRunId('run-abc-123-def')).not.toThrow();
  });

  it('accepts a single character runId', () => {
    expect(() => validateRunId('r')).not.toThrow();
  });

  it('accepts a 256-character runId (at limit)', () => {
    expect(() => validateRunId('r'.repeat(256))).not.toThrow();
  });

  it('rejects empty string', () => {
    expect(() => validateRunId('')).toThrow(ValidationError);
    try {
      validateRunId('');
    } catch (err) {
      expect((err as ValidationError).kind).toBe('invalid_run_id');
    }
  });

  it('rejects whitespace-only string', () => {
    expect(() => validateRunId('   ')).toThrow(ValidationError);
    try {
      validateRunId('   ');
    } catch (err) {
      expect((err as ValidationError).kind).toBe('invalid_run_id');
    }
  });

  it('rejects string exceeding 256 characters', () => {
    expect(() => validateRunId('r'.repeat(257))).toThrow(ValidationError);
    try {
      validateRunId('r'.repeat(257));
    } catch (err) {
      expect((err as ValidationError).kind).toBe('invalid_run_id');
    }
  });

  it('uses sentinel engineId and correlationId in error', () => {
    try {
      validateRunId('');
    } catch (err) {
      expect((err as ValidationError).engineId).toBe('validator');
      expect((err as ValidationError).correlationId).toBe('validator');
    }
  });
});
