/**
 * Contract tests for the 4-class error hierarchy.
 *
 * Proves:
 * - Each class exists and carries kind/engineId/correlationId
 * - kind is type-narrowed per class (closed literal unions)
 * - instanceof checks work correctly for each class
 * - cause is preserved
 * - All four classes extend HoplonError
 */

import { describe, it, expect } from 'vitest';
import {
  HoplonError,
  EngineError,
  AdapterError,
  SemanticError,
  ValidationError,
} from '../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// HoplonError base class
// ---------------------------------------------------------------------------

describe('HoplonError', () => {
  it('can be instantiated directly with all required fields', () => {
    const err = new HoplonError('test', {
      kind: 'some_kind',
      engineId: 'local-0',
      correlationId: 'corr-abc',
    });
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(Error);
    expect(err.kind).toBe('some_kind');
    expect(err.engineId).toBe('local-0');
    expect(err.correlationId).toBe('corr-abc');
    expect(err.message).toBe('test');
  });

  it('preserves cause when provided', () => {
    const originalErr = new Error('original');
    const err = new HoplonError('wrapped', {
      kind: 'k',
      engineId: 'e',
      correlationId: 'c',
      cause: originalErr,
    });
    expect(err.cause).toBe(originalErr);
  });
});

// ---------------------------------------------------------------------------
// EngineError
// ---------------------------------------------------------------------------

describe('EngineError', () => {
  it('is instanceof EngineError and HoplonError', () => {
    const err = new EngineError({
      kind: 'missing_adapter',
      engineId: 'local-0',
      correlationId: 'factory',
    });
    expect(err).toBeInstanceOf(EngineError);
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(Error);
  });

  it('carries kind, engineId, correlationId', () => {
    const err = new EngineError({
      kind: 'not_implemented',
      engineId: 'test-engine',
      correlationId: 'corr-001',
    });
    expect(err.kind).toBe('not_implemented');
    expect(err.engineId).toBe('test-engine');
    expect(err.correlationId).toBe('corr-001');
  });

  it('accepts all valid EngineErrorKind values', () => {
    const kinds = [
      'missing_adapter',
      'not_implemented',
      'wasm_load_failed',
      'grammar_not_registered',
      'config_invalid',
      'remote_not_supported',
      'reconcile_failed',
    ] as const;
    for (const kind of kinds) {
      const err = new EngineError({ kind, engineId: 'e', correlationId: 'c' });
      expect(err.kind).toBe(kind);
    }
  });

  it('has default message when none provided', () => {
    const err = new EngineError({ kind: 'missing_adapter', engineId: 'e', correlationId: 'c' });
    expect(err.message).toContain('missing_adapter');
  });

  it('preserves custom message', () => {
    const err = new EngineError(
      { kind: 'missing_adapter', engineId: 'e', correlationId: 'c' },
      'Custom message',
    );
    expect(err.message).toBe('Custom message');
  });

  it('preserves cause', () => {
    const cause = { adapter: 'fs' };
    const err = new EngineError({
      kind: 'missing_adapter',
      engineId: 'e',
      correlationId: 'c',
      cause,
    });
    expect(err.cause).toBe(cause);
  });

  it('is NOT instanceof AdapterError, SemanticError, or ValidationError', () => {
    const err = new EngineError({ kind: 'missing_adapter', engineId: 'e', correlationId: 'c' });
    expect(err instanceof AdapterError).toBe(false);
    expect(err instanceof SemanticError).toBe(false);
    expect(err instanceof ValidationError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AdapterError
// ---------------------------------------------------------------------------

describe('AdapterError', () => {
  it('is instanceof AdapterError and HoplonError', () => {
    const err = new AdapterError({
      kind: 'fs_read_failed',
      engineId: 'local-0',
      correlationId: 'corr-abc',
    });
    expect(err).toBeInstanceOf(AdapterError);
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(Error);
  });

  it('carries kind, engineId, correlationId', () => {
    const err = new AdapterError({
      kind: 'git_commit_failed',
      engineId: 'e',
      correlationId: 'c',
    });
    expect(err.kind).toBe('git_commit_failed');
    expect(err.engineId).toBe('e');
    expect(err.correlationId).toBe('c');
  });

  it('accepts all valid AdapterErrorKind values', () => {
    const kinds = [
      'fs_read_failed',
      'fs_write_failed',
      'git_commit_failed',
      'git_checkout_failed',
      'snapshot_store_write_failed',
      'snapshot_store_read_failed',
      'lock_acquire_failed',
      'parser_init_failed',
    ] as const;
    for (const kind of kinds) {
      const err = new AdapterError({ kind, engineId: 'e', correlationId: 'c' });
      expect(err.kind).toBe(kind);
    }
  });

  it('is NOT instanceof EngineError', () => {
    const err = new AdapterError({ kind: 'fs_read_failed', engineId: 'e', correlationId: 'c' });
    expect(err instanceof EngineError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// SemanticError
// ---------------------------------------------------------------------------

describe('SemanticError', () => {
  it('is instanceof SemanticError and HoplonError', () => {
    const err = new SemanticError({
      kind: 'snapshot_missing',
      engineId: 'local-0',
      correlationId: 'corr-abc',
    });
    expect(err).toBeInstanceOf(SemanticError);
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts all valid SemanticErrorKind values', () => {
    const kinds = [
      'snapshot_missing',
      'manifest_version_mismatch',
      'audit_version_mismatch',
      'project_id_mismatch',
      'run_id_mismatch',
      'snapshot_not_committed',
    ] as const;
    for (const kind of kinds) {
      const err = new SemanticError({ kind, engineId: 'e', correlationId: 'c' });
      expect(err.kind).toBe(kind);
    }
  });

  it('is NOT instanceof EngineError or AdapterError', () => {
    const err = new SemanticError({ kind: 'snapshot_missing', engineId: 'e', correlationId: 'c' });
    expect(err instanceof EngineError).toBe(false);
    expect(err instanceof AdapterError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ValidationError
// ---------------------------------------------------------------------------

describe('ValidationError', () => {
  it('is instanceof ValidationError and HoplonError', () => {
    const err = new ValidationError({
      kind: 'path_traversal',
      engineId: 'local-0',
      correlationId: 'util',
    });
    expect(err).toBeInstanceOf(ValidationError);
    expect(err).toBeInstanceOf(HoplonError);
    expect(err).toBeInstanceOf(Error);
  });

  it('accepts all valid ValidationErrorKind values', () => {
    const kinds = [
      'invalid_manifest',
      'invalid_scope',
      'invalid_path',
      'path_traversal',
      'manifest_too_large',
      'file_too_large_for_manifest',
      'invalid_correlation_id',
      'invalid_run_id',
    ] as const;
    for (const kind of kinds) {
      const err = new ValidationError({ kind, engineId: 'e', correlationId: 'c' });
      expect(err.kind).toBe(kind);
    }
  });

  it('is NOT instanceof EngineError, AdapterError, or SemanticError', () => {
    const err = new ValidationError({ kind: 'path_traversal', engineId: 'e', correlationId: 'c' });
    expect(err instanceof EngineError).toBe(false);
    expect(err instanceof AdapterError).toBe(false);
    expect(err instanceof SemanticError).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// instanceof cross-checks
// ---------------------------------------------------------------------------

describe('instanceof cross-checks', () => {
  it('each subclass is instanceof HoplonError', () => {
    expect(new EngineError({ kind: 'not_implemented', engineId: 'e', correlationId: 'c' })).toBeInstanceOf(HoplonError);
    expect(new AdapterError({ kind: 'fs_read_failed', engineId: 'e', correlationId: 'c' })).toBeInstanceOf(HoplonError);
    expect(new SemanticError({ kind: 'snapshot_missing', engineId: 'e', correlationId: 'c' })).toBeInstanceOf(HoplonError);
    expect(new ValidationError({ kind: 'path_traversal', engineId: 'e', correlationId: 'c' })).toBeInstanceOf(HoplonError);
  });

  it('no subclass is instanceof another subclass', () => {
    const engine = new EngineError({ kind: 'not_implemented', engineId: 'e', correlationId: 'c' });
    const adapter = new AdapterError({ kind: 'fs_read_failed', engineId: 'e', correlationId: 'c' });
    const semantic = new SemanticError({ kind: 'snapshot_missing', engineId: 'e', correlationId: 'c' });
    const validation = new ValidationError({ kind: 'path_traversal', engineId: 'e', correlationId: 'c' });

    expect(engine instanceof AdapterError).toBe(false);
    expect(engine instanceof SemanticError).toBe(false);
    expect(engine instanceof ValidationError).toBe(false);
    expect(adapter instanceof EngineError).toBe(false);
    expect(adapter instanceof SemanticError).toBe(false);
    expect(adapter instanceof ValidationError).toBe(false);
    expect(semantic instanceof EngineError).toBe(false);
    expect(semantic instanceof AdapterError).toBe(false);
    expect(semantic instanceof ValidationError).toBe(false);
    expect(validation instanceof EngineError).toBe(false);
    expect(validation instanceof AdapterError).toBe(false);
    expect(validation instanceof SemanticError).toBe(false);
  });
});
