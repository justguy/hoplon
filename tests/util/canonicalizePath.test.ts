/**
 * Tests for canonicalizePath utility.
 *
 * Proves:
 * - Rejects .. segments that escape root
 * - Rejects absolute paths (POSIX and Windows)
 * - Accepts valid relative paths
 * - Throws ValidationError({ kind: 'path_traversal' }) with sentinel correlationId
 */

import { describe, it, expect } from 'vitest';
import { canonicalizePath } from '../../src/hoplon/util/canonicalizePath.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';
import { resolve } from 'node:path';

const ROOT = '/projects/widget-app';

// ---------------------------------------------------------------------------
// Valid paths
// ---------------------------------------------------------------------------

describe('canonicalizePath — valid paths', () => {
  it('accepts a simple relative path', () => {
    const result = canonicalizePath({ path: 'src/util/format.ts', root: ROOT });
    expect(result).toBe(resolve(ROOT, 'src/util/format.ts'));
  });

  it('accepts a deeply nested path', () => {
    const result = canonicalizePath({ path: 'a/b/c/d.ts', root: ROOT });
    expect(result).toBe(resolve(ROOT, 'a/b/c/d.ts'));
  });

  it('accepts a path at the root level', () => {
    const result = canonicalizePath({ path: 'README.md', root: ROOT });
    expect(result).toBe(resolve(ROOT, 'README.md'));
  });

  it('returns an absolute path', () => {
    const result = canonicalizePath({ path: 'src/test.ts', root: ROOT });
    expect(result.startsWith('/')).toBe(true);
  });

  it('uses provided engineId and correlationId on success', () => {
    // Should not throw, just return the path
    expect(() =>
      canonicalizePath({
        path: 'src/valid.ts',
        root: ROOT,
        engineId: 'my-engine',
        correlationId: 'my-corr',
      }),
    ).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// Path traversal rejection
// ---------------------------------------------------------------------------

describe('canonicalizePath — path traversal rejection', () => {
  it('rejects path with leading ..', () => {
    expect(() =>
      canonicalizePath({ path: '../outside/secret.ts', root: ROOT }),
    ).toThrow(ValidationError);
  });

  it('rejects path that navigates out then back', () => {
    expect(() =>
      canonicalizePath({ path: 'src/../../outside.ts', root: ROOT }),
    ).toThrow(ValidationError);
  });

  it('throws ValidationError with kind path_traversal', () => {
    try {
      canonicalizePath({ path: '../etc/passwd', root: ROOT });
      expect.fail('should have thrown');
    } catch (err) {
      expect(err).toBeInstanceOf(ValidationError);
      expect((err as ValidationError).kind).toBe('path_traversal');
    }
  });

  it('uses sentinel correlationId when not provided', () => {
    try {
      canonicalizePath({ path: '../escape.ts', root: ROOT });
    } catch (err) {
      expect((err as ValidationError).correlationId).toBe('util');
      expect((err as ValidationError).engineId).toBe('util');
    }
  });

  it('uses provided engineId in error', () => {
    try {
      canonicalizePath({ path: '../escape.ts', root: ROOT, engineId: 'my-engine', correlationId: 'my-corr' });
    } catch (err) {
      expect((err as ValidationError).engineId).toBe('my-engine');
      expect((err as ValidationError).correlationId).toBe('my-corr');
    }
  });

  it('rejects POSIX absolute path', () => {
    expect(() =>
      canonicalizePath({ path: '/etc/passwd', root: ROOT }),
    ).toThrow(ValidationError);

    try {
      canonicalizePath({ path: '/etc/passwd', root: ROOT });
    } catch (err) {
      expect((err as ValidationError).kind).toBe('path_traversal');
    }
  });

  it('rejects Windows-style absolute path', () => {
    expect(() =>
      canonicalizePath({ path: 'C:\\Windows\\System32', root: ROOT }),
    ).toThrow(ValidationError);
  });

  it('rejects Windows-style absolute path with forward slash', () => {
    expect(() =>
      canonicalizePath({ path: 'C:/Windows/System32', root: ROOT }),
    ).toThrow(ValidationError);
  });
});
