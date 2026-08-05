/**
 * tests/concurrency/projectRegistryGrammars.test.ts — F1 regression.
 *
 * Registering an external project without an explicit grammarsDir must resolve
 * to the grammars packaged with the installed hoplon package — never
 * `<project>/vendor/grammars`, which normally does not exist and used to cause a
 * deferred parser-init failure. And the grammars-directory validator must fail
 * immediately with a typed, actionable error when the directory is missing.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';

import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import {
  assertGrammarsDirPresent,
  resolvePackagedGrammarsDir,
} from '../../src/hoplon/engine/grammarsDir.js';
import { EngineError } from '../../src/hoplon/contracts/errors.js';

describe('F1 — registry grammarsDir defaults to packaged grammars', () => {
  it('resolves to a populated packaged grammars dir, not <project>/vendor/grammars', () => {
    const registry = createProjectRegistry();
    const fsRoot = '/definitely/not/a/real/project/root';
    const record = registry.register({ projectId: 'ext-proj', fsRoot });

    // Never silently defers to the (missing) project-local grammars path.
    expect(record.grammarsDir).not.toBe(`${fsRoot}/vendor/grammars`);
    expect(record.grammarsDir).not.toContain(fsRoot);

    // The resolved directory actually exists and contains the runtime wasm.
    expect(fs.statSync(record.grammarsDir).isDirectory()).toBe(true);
    expect(fs.existsSync(path.join(record.grammarsDir, 'tree-sitter.wasm'))).toBe(true);
  });

  it('honours an explicit grammarsDir override', () => {
    const registry = createProjectRegistry();
    const record = registry.register({
      projectId: 'explicit',
      fsRoot: '/some/root',
      grammarsDir: '/custom/grammars',
    });
    expect(record.grammarsDir).toBe('/custom/grammars');
  });
});

describe('F1 — assertGrammarsDirPresent', () => {
  it('throws a typed, actionable error naming the missing path', () => {
    let caught: unknown;
    try {
      assertGrammarsDirPresent('/no/such/vendor/grammars', {
        engineId: 'e0',
        correlationId: 'c0',
      });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(EngineError);
    const engineErr = caught as EngineError;
    expect(engineErr.kind).toBe('grammars_dir_missing');
    expect(engineErr.message).toContain('/no/such/vendor/grammars');
    expect(engineErr.message).toContain('fetch-grammars');
  });

  it('throws when no packaged grammars directory can be located (null)', () => {
    expect(() =>
      assertGrammarsDirPresent(null, { engineId: 'e0', correlationId: 'c0' }),
    ).toThrow(EngineError);
  });

  it('does not throw for the packaged grammars directory', () => {
    const packaged = resolvePackagedGrammarsDir();
    expect(packaged).not.toBeNull();
    expect(() =>
      assertGrammarsDirPresent(packaged, { engineId: 'e0', correlationId: 'c0' }),
    ).not.toThrow();
  });
});
