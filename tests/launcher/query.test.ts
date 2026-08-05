/**
 * tests/launcher/query.test.ts — parse + dispatch proof for the read-only
 * `hoplon query` intelligence surface.
 *
 * Covers:
 *   - parseQueryCommand: capabilities / skeleton / structure shapes and
 *     the rejection paths (missing files, unsupported language).
 *   - runQuery integration: capabilities / skeleton / structure dispatch
 *     against a real engine in a temp workspace.
 *   - renderQueryHuman: minimal envelope rendering.
 *   - parseCli + runCli: query branch dispatch through the launcher seam.
 *
 * The integration portion uses the repo's vendored tree-sitter grammars so
 * the engine can parse a small TypeScript fixture placed in the temp
 * workspace; no external assets or network I/O.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { parseQueryCommand, runQuery } from '../../src/hoplon/launcher/query.js';
import { renderQueryHuman } from '../../src/hoplon/launcher/queryHuman.js';
import { parseCli, runCli } from '../../src/hoplon/launcher/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-launcher-query-'));
}

function recordingIo() {
  const out: string[] = [];
  const err: string[] = [];
  return {
    out,
    err,
    io: {
      stdout: (line: string) => out.push(line),
      stderr: (line: string) => err.push(line),
      version: '0.0.0-test',
    },
  };
}

describe('parseQueryCommand', () => {
  it('rejects empty tokens', () => {
    const parsed = parseQueryCommand([]);
    expect(parsed.kind).toBe('error');
  });

  it('parses `capabilities` with default json format', () => {
    const parsed = parseQueryCommand(['capabilities']);
    expect(parsed.kind).toBe('parsed');
    if (parsed.kind === 'parsed') {
      expect(parsed.command).toEqual({ kind: 'capabilities' });
      expect(parsed.format).toBe('json');
    }
  });

  it('accepts --format human', () => {
    const parsed = parseQueryCommand(['capabilities', '--format', 'human']);
    if (parsed.kind === 'parsed') {
      expect(parsed.format).toBe('human');
    } else {
      throw new Error('expected parsed');
    }
  });

  it('rejects unknown --format values', () => {
    const parsed = parseQueryCommand(['capabilities', '--format', 'yaml']);
    expect(parsed.kind).toBe('error');
  });

  it('parses `skeleton` with repeated --file', () => {
    const parsed = parseQueryCommand(['skeleton', '--file', 'a.ts', '--file', 'b.ts']);
    if (parsed.kind === 'parsed' && parsed.command.kind === 'skeleton') {
      expect(parsed.command.files).toEqual(['a.ts', 'b.ts']);
    } else {
      throw new Error('expected skeleton parsed');
    }
  });

  it('rejects `skeleton` without --file', () => {
    expect(parseQueryCommand(['skeleton']).kind).toBe('error');
  });

  it('parses `structure` with language + pattern', () => {
    const parsed = parseQueryCommand([
      'structure',
      '--file',
      'a.ts',
      '--language',
      'typescript',
      '--pattern',
      '(function_declaration name: (identifier) @n)',
    ]);
    if (parsed.kind === 'parsed' && parsed.command.kind === 'structure') {
      expect(parsed.command.files).toEqual(['a.ts']);
      expect(parsed.command.language).toBe('typescript');
      expect(parsed.command.pattern).toContain('function_declaration');
      expect(parsed.command.queryId).toBe('cli-query-structure');
    } else {
      throw new Error('expected structure parsed');
    }
  });

  it('accepts js/ts aliases and normalises them', () => {
    const jsParsed = parseQueryCommand([
      'structure',
      '--file',
      'a.js',
      '--language',
      'js',
      '--pattern',
      '(function_declaration name: (identifier) @n)',
    ]);
    const tsParsed = parseQueryCommand([
      'structure',
      '--file',
      'a.ts',
      '--language',
      'ts',
      '--pattern',
      '(function_declaration name: (identifier) @n)',
    ]);
    if (
      jsParsed.kind === 'parsed' &&
      jsParsed.command.kind === 'structure' &&
      tsParsed.kind === 'parsed' &&
      tsParsed.command.kind === 'structure'
    ) {
      expect(jsParsed.command.language).toBe('javascript');
      expect(tsParsed.command.language).toBe('typescript');
    } else {
      throw new Error('expected aliased structure commands to parse');
    }
  });

  it('rejects unsupported --language', () => {
    const parsed = parseQueryCommand([
      'structure',
      '--file',
      'a.ts',
      '--language',
      'ruby',
      '--pattern',
      '(x)',
    ]);
    expect(parsed.kind).toBe('error');
  });

  it('rejects `structure` without --pattern', () => {
    const parsed = parseQueryCommand([
      'structure',
      '--file',
      'a.ts',
      '--language',
      'typescript',
    ]);
    expect(parsed.kind).toBe('error');
  });

  it('rejects unknown query subcommands', () => {
    expect(parseQueryCommand(['bogus']).kind).toBe('error');
  });

  it('parses `search` with --pattern only', () => {
    const parsed = parseQueryCommand(['search', '--pattern', '^create']);
    if (parsed.kind === 'parsed' && parsed.command.kind === 'search') {
      expect(parsed.command.namePattern).toBe('^create');
      expect(parsed.command.files).toBeUndefined();
      expect(parsed.command.kinds).toBeUndefined();
    } else {
      throw new Error('expected search parsed');
    }
  });

  it('parses `search` with kinds and max-results', () => {
    const parsed = parseQueryCommand([
      'search',
      '--pattern',
      'Service$',
      '--kind',
      'class',
      '--kind',
      'interface',
      '--max-results',
      '50',
      '--file',
      'src/a.ts',
    ]);
    if (parsed.kind === 'parsed' && parsed.command.kind === 'search') {
      expect(parsed.command.kinds).toEqual(['class', 'interface']);
      expect(parsed.command.maxResults).toBe(50);
      expect(parsed.command.files).toEqual(['src/a.ts']);
    } else {
      throw new Error('expected search parsed');
    }
  });

  it('rejects `search` without --pattern', () => {
    expect(parseQueryCommand(['search']).kind).toBe('error');
  });

  it('rejects unknown --kind on `search`', () => {
    expect(
      parseQueryCommand(['search', '--pattern', '.*', '--kind', 'lambda']).kind,
    ).toBe('error');
  });

  it('rejects non-positive --max-results on `search`', () => {
    expect(
      parseQueryCommand(['search', '--pattern', '.*', '--max-results', '0']).kind,
    ).toBe('error');
  });

  it('parses `project` with no flags', () => {
    const parsed = parseQueryCommand(['project']);
    if (parsed.kind === 'parsed' && parsed.command.kind === 'project') {
      expect(parsed.command.maxFiles).toBeUndefined();
    } else {
      throw new Error('expected project parsed');
    }
  });

  it('parses `project` with --max-files and --sample-paths', () => {
    const parsed = parseQueryCommand([
      'project',
      '--max-files',
      '10',
      '--sample-paths',
      '5',
    ]);
    if (parsed.kind === 'parsed' && parsed.command.kind === 'project') {
      expect(parsed.command.maxFiles).toBe(10);
      expect(parsed.command.samplePathsPerLanguage).toBe(5);
    } else {
      throw new Error('expected project parsed');
    }
  });
});

describe('parseCli query branch', () => {
  it('routes `query capabilities` through the launcher parser', () => {
    const parsed = parseCli(['query', 'capabilities', '--root', '/tmp/ws']);
    expect(parsed.command.kind).toBe('query');
    if (parsed.command.kind === 'query') {
      expect(parsed.command.query).toEqual({ kind: 'capabilities' });
      expect(parsed.command.format).toBe('json');
      expect(parsed.command.workspace.root).toBe('/tmp/ws');
    }
  });

  it('shows the query-specific help for `query --help`', () => {
    const parsed = parseCli(['query', '--help']);
    expect(parsed.command.kind).toBe('query-help');
  });

  it('propagates query parse errors as top-level launcher errors', () => {
    const parsed = parseCli(['query', 'skeleton']);
    expect(parsed.command.kind).toBe('error');
  });
});

describe('runQuery integration', () => {
  it('capabilities returns an ok envelope with the catalog', async () => {
    const root = makeTempWorkspace();
    try {
      const envelope = await runQuery({
        workspace: { root, grammarsDir: GRAMMARS_DIR, engineId: 'query-test-0' },
        command: { kind: 'capabilities' },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('query capabilities');
      expect(envelope.engineId).toBe('query-test-0');
      const data = envelope.data as { capabilities: unknown[] };
      expect(Array.isArray(data.capabilities)).toBe(true);
      expect(data.capabilities.length).toBeGreaterThan(0);
      expect(fs.existsSync(path.join(root, '.hoplon'))).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('skeleton returns a structural template against a real file', async () => {
    const root = makeTempWorkspace();
    try {
      fs.writeFileSync(
        path.join(root, 'sample.ts'),
        'export function hello(name: string): string { return name; }\n',
      );
      const envelope = await runQuery({
        workspace: { root, grammarsDir: GRAMMARS_DIR, engineId: 'query-test-0' },
        command: { kind: 'skeleton', files: ['sample.ts'] },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('query skeleton');
      const data = envelope.data as { files: Array<{ path: string; exports: unknown[] }> };
      expect(data.files.length).toBe(1);
      expect(data.files[0]?.path).toBe('sample.ts');
      expect(data.files[0]?.exports.length).toBeGreaterThan(0);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('search returns matches from a real workspace file', async () => {
    const root = makeTempWorkspace();
    try {
      fs.writeFileSync(
        path.join(root, 'sample.ts'),
        'export function createSession(): void {}\nexport class SessionService {}\n',
      );
      const envelope = await runQuery({
        workspace: { root, grammarsDir: GRAMMARS_DIR, engineId: 'query-test-0' },
        command: { kind: 'search', namePattern: '^create', kinds: ['function'] },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('query search');
      const data = envelope.data as {
        matches: Array<{ name: string; kind: string }>;
        truncated: boolean;
      };
      expect(data.truncated).toBe(false);
      expect(data.matches.some((m) => m.name === 'createSession' && m.kind === 'function')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('project returns per-language counts and a parsed sample', async () => {
    const root = makeTempWorkspace();
    try {
      fs.writeFileSync(path.join(root, 'a.ts'), 'export function a(){}\n');
      fs.writeFileSync(path.join(root, 'b.ts'), 'export class B {}\n');
      const envelope = await runQuery({
        workspace: { root, grammarsDir: GRAMMARS_DIR, engineId: 'query-test-0' },
        command: { kind: 'project' },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('query project');
      const data = envelope.data as {
        files: { total: number; byLanguage: Array<{ language: string; fileCount: number }> };
        symbols: { functions: number; classes: number };
        truncated: boolean;
      };
      expect(data.files.total).toBe(2);
      expect(data.symbols.functions).toBeGreaterThanOrEqual(1);
      expect(data.symbols.classes).toBeGreaterThanOrEqual(1);
      expect(data.truncated).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('structure runs a tree-sitter pattern and returns matches', async () => {
    const root = makeTempWorkspace();
    try {
      fs.writeFileSync(
        path.join(root, 'sample.ts'),
        'export function hello(name: string): string { return name; }\n',
      );
      const envelope = await runQuery({
        workspace: { root, grammarsDir: GRAMMARS_DIR, engineId: 'query-test-0' },
        command: {
          kind: 'structure',
          files: ['sample.ts'],
          language: 'typescript',
          pattern: '(function_declaration name: (identifier) @name)',
          queryId: 'test-structure',
        },
      });
      expect(envelope.ok).toBe(true);
      expect(envelope.command).toBe('query structure');
      const data = envelope.data as {
        matches: Array<{ captureName: string; text: string }>;
        failures: unknown[];
      };
      expect(data.matches.some((m) => m.text === 'hello')).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});

describe('renderQueryHuman', () => {
  it('renders an ok capabilities envelope', () => {
    const text = renderQueryHuman({
      ok: true,
      version: 1,
      command: 'query capabilities',
      engineId: 'local-0',
      data: {
        catalogVersion: 1,
        engineId: 'local-0',
        capabilities: [
          {
            descriptor: {
              capabilityId: 'codeIntelligence',
              runtimeState: 'shipped',
            },
          },
        ],
      },
    });
    expect(text).toContain('query capabilities');
    expect(text).toContain('codeIntelligence');
  });

  it('renders an error envelope with its kind and message', () => {
    const text = renderQueryHuman({
      ok: false,
      version: 1,
      command: 'query structure',
      engineId: 'local-0',
      error: { kind: 'invalid_query', message: 'bad pattern' },
    });
    expect(text).toContain('error');
    expect(text).toContain('invalid_query');
    expect(text).toContain('bad pattern');
  });
});

describe('runCli query dispatch', () => {
  it('emits a JSON envelope to stdout and exits 0 on success', async () => {
    const root = makeTempWorkspace();
    try {
      const rec = recordingIo();
      const code = await runCli(
        [
          'query',
          'capabilities',
          '--root',
          root,
          '--grammars-dir',
          GRAMMARS_DIR,
          '--engine-id',
          'runcli-query-0',
        ],
        rec.io,
      );
      expect(code).toBe(0);
      expect(rec.out.length).toBe(1);
      const parsed = JSON.parse(rec.out[0]!);
      expect(parsed.ok).toBe(true);
      expect(parsed.command).toBe('query capabilities');
      expect(parsed.engineId).toBe('runcli-query-0');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
