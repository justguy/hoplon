/**
 * tests/launcher/config.test.ts — workspace resolver unit tests.
 *
 * Pure data tests: no engine, no filesystem.
 */

import { describe, it, expect } from 'vitest';
import { resolve as resolvePath, join } from 'node:path';

import { resolveLauncherWorkspace } from '../../src/hoplon/launcher/config.js';

describe('resolveLauncherWorkspace', () => {
  it('defaults root to CWD and computes sibling paths', () => {
    const cfg = resolveLauncherWorkspace({});
    expect(cfg.root).toBe(resolvePath(process.cwd()));
    expect(cfg.dbPath).toBe(join(cfg.root, '.hoplon/hoplon.db'));
    expect(cfg.gitRepoDir).toBe('.hoplon/repo');
    expect(cfg.engineId).toBe('local-0');
    expect(cfg.grammarsDir).toMatch(/vendor[/\\]grammars$/);
  });

  it('honors explicit overrides for every field', () => {
    const cfg = resolveLauncherWorkspace({
      root: '/tmp/workspace-x',
      dbPath: '/tmp/custom.db',
      gitRepoDir: 'custom/repo',
      grammarsDir: '/tmp/grammars',
      engineId: 'hoplon-on-hoplon',
    });
    expect(cfg.root).toBe(resolvePath('/tmp/workspace-x'));
    expect(cfg.dbPath).toBe(resolvePath('/tmp/custom.db'));
    expect(cfg.gitRepoDir).toBe('custom/repo');
    expect(cfg.grammarsDir).toBe(resolvePath('/tmp/grammars'));
    expect(cfg.engineId).toBe('hoplon-on-hoplon');
  });

  it('resolves relative root to an absolute path', () => {
    const cfg = resolveLauncherWorkspace({ root: './relative-subdir' });
    expect(cfg.root.startsWith('/')).toBe(true);
  });

  it('resolves relative dbPath and grammarsDir against the selected workspace root', () => {
    const cfg = resolveLauncherWorkspace({
      root: '/tmp/workspace-y',
      dbPath: '.hoplon/custom.sqlite',
      grammarsDir: 'vendor/grammars-dev',
    });
    expect(cfg.dbPath).toBe(resolvePath('/tmp/workspace-y/.hoplon/custom.sqlite'));
    expect(cfg.grammarsDir).toBe(resolvePath('/tmp/workspace-y/vendor/grammars-dev'));
  });
});
