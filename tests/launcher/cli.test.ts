/**
 * tests/launcher/cli.test.ts — argv parsing and dispatch surface.
 *
 * Proves the launcher's argument parser produces the correct command
 * structure for every public subcommand, and that --help / --version /
 * invalid commands route through the runCli IO seam.
 *
 * Does not start any servers — those paths are proved in mcpServe /
 * httpServe tests.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  parseCli,
  runCli,
  HELP_TEXT,
} from '../../src/hoplon/launcher/cli.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-launcher-cli-'));
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

describe('parseCli', () => {
  it('treats an empty argv as help', () => {
    expect(parseCli([])).toEqual({ command: { kind: 'help' } });
  });

  it('accepts --help and -h', () => {
    expect(parseCli(['--help'])).toEqual({ command: { kind: 'help' } });
    expect(parseCli(['-h'])).toEqual({ command: { kind: 'help' } });
  });

  it('accepts --version and -v', () => {
    expect(parseCli(['--version'])).toEqual({ command: { kind: 'version' } });
    expect(parseCli(['-v'])).toEqual({ command: { kind: 'version' } });
  });

  it('parses `status` with defaults', () => {
    const parsed = parseCli(['status']);
    expect(parsed.command.kind).toBe('status');
    if (parsed.command.kind === 'status') {
      expect(parsed.command.format).toBe('json');
      expect(parsed.command.workspace).toEqual({});
    }
  });

  it('parses `status --root X --format human`', () => {
    const parsed = parseCli(['status', '--root', '/tmp/ws', '--format', 'human']);
    expect(parsed.command.kind).toBe('status');
    if (parsed.command.kind === 'status') {
      expect(parsed.command.format).toBe('human');
      expect(parsed.command.workspace.root).toBe('/tmp/ws');
    }
  });

  it('rejects an unknown status format', () => {
    const parsed = parseCli(['status', '--format', 'yaml']);
    expect(parsed.command.kind).toBe('error');
  });

  it('parses `mcp serve` with stdio default', () => {
    const parsed = parseCli(['mcp', 'serve']);
    expect(parsed.command.kind).toBe('mcp-serve');
    if (parsed.command.kind === 'mcp-serve') {
      expect(parsed.command.transport).toBe('stdio');
      expect(parsed.command.port).toBeUndefined();
      expect(parsed.command.agentToolProfile).toBe('default');
    }
  });

  it('parses `mcp serve --transport sse --port 4100`', () => {
    const parsed = parseCli(['mcp', 'serve', '--transport', 'sse', '--port', '4100']);
    expect(parsed.command.kind).toBe('mcp-serve');
    if (parsed.command.kind === 'mcp-serve') {
      expect(parsed.command.transport).toBe('sse');
      expect(parsed.command.port).toBe(4100);
    }
  });

  it('parses `mcp serve --agent-profile strict-agent`', () => {
    const parsed = parseCli(['mcp', 'serve', '--agent-profile', 'strict-agent']);
    expect(parsed.command.kind).toBe('mcp-serve');
    if (parsed.command.kind === 'mcp-serve') {
      expect(parsed.command.agentToolProfile).toBe('strict_agent');
    }
  });

  it('rejects an unknown mcp transport', () => {
    const parsed = parseCli(['mcp', 'serve', '--transport', 'gopher']);
    expect(parsed.command.kind).toBe('error');
  });

  it('rejects a non-numeric port', () => {
    const parsed = parseCli(['mcp', 'serve', '--transport', 'sse', '--port', 'abc']);
    expect(parsed.command.kind).toBe('error');
  });

  it('parses `http serve --host 0.0.0.0 --port 8080`', () => {
    const parsed = parseCli(['http', 'serve', '--host', '0.0.0.0', '--port', '8080']);
    expect(parsed.command.kind).toBe('http-serve');
    if (parsed.command.kind === 'http-serve') {
      expect(parsed.command.host).toBe('0.0.0.0');
      expect(parsed.command.port).toBe(8080);
      expect(parsed.command.agentToolProfile).toBe('default');
    }
  });

  it('parses `http serve --agent-profile strict-agent`', () => {
    const parsed = parseCli(['http', 'serve', '--agent-profile', 'strict-agent']);
    expect(parsed.command.kind).toBe('http-serve');
    if (parsed.command.kind === 'http-serve') {
      expect(parsed.command.agentToolProfile).toBe('strict_agent');
    }
  });

  it('rejects an unknown agent profile on server commands', () => {
    const mcp = parseCli(['mcp', 'serve', '--agent-profile', 'raw']);
    const http = parseCli(['http', 'serve', '--agent-profile', 'raw']);
    expect(mcp.command.kind).toBe('error');
    expect(http.command.kind).toBe('error');
    if (mcp.command.kind === 'error') {
      expect(mcp.command.message).toContain('Supported profiles: default, strict-agent');
      expect(mcp.command.message).toContain('fails closed');
    }
    if (http.command.kind === 'error') {
      expect(http.command.message).toContain('Supported profiles: default, strict-agent');
      expect(http.command.message).toContain('fails closed');
    }
  });

  it('threads workspace flags through every subcommand', () => {
    const parsed = parseCli([
      'http',
      'serve',
      '--root',
      '/tmp/ws',
      '--db',
      '/tmp/ws/db.sqlite',
      '--git-repo-dir',
      'repo',
      '--grammars-dir',
      '/tmp/grammars',
      '--engine-id',
      'eng-1',
    ]);
    if (parsed.command.kind === 'http-serve') {
      expect(parsed.command.workspace).toEqual({
        root: '/tmp/ws',
        dbPath: '/tmp/ws/db.sqlite',
        gitRepoDir: 'repo',
        grammarsDir: '/tmp/grammars',
        engineId: 'eng-1',
      });
    } else {
      throw new Error('expected http-serve command');
    }
  });

  it('returns a descriptive error for unknown top-level commands', () => {
    const parsed = parseCli(['bogus']);
    expect(parsed.command.kind).toBe('error');
  });
});

describe('runCli dispatch (non-server paths)', () => {
  it('--help writes HELP_TEXT to stdout and returns 0', async () => {
    const rec = recordingIo();
    const code = await runCli(['--help'], rec.io);
    expect(code).toBe(0);
    expect(rec.out).toEqual([HELP_TEXT]);
    expect(rec.out[0]).toContain('.mcp.json');
    expect(rec.out[0]).toContain('.codex/config.toml');
    expect(rec.out[0]).toContain('host/launcher-owned');
    expect(rec.err).toEqual([]);
  });

  it('--version writes the version to stdout', async () => {
    const rec = recordingIo();
    const code = await runCli(['--version'], rec.io);
    expect(code).toBe(0);
    expect(rec.out).toEqual(['0.0.0-test']);
  });

  it('unknown command writes to stderr and returns exit code 2', async () => {
    const rec = recordingIo();
    const code = await runCli(['bogus'], rec.io);
    expect(code).toBe(2);
    expect(rec.err.some((l) => l.includes('Unknown command'))).toBe(true);
  });

  it('renders the live usage bundle on `status --format human`', async () => {
    const root = makeTempWorkspace();
    const rec = recordingIo();
    try {
      const code = await runCli(
        [
          'status',
          '--format',
          'human',
          '--root',
          root,
          '--grammars-dir',
          GRAMMARS_DIR,
          '--engine-id',
          'launcher-cli-test-0',
        ],
        rec.io,
      );

      expect(code).toBe(0);
      expect(rec.err).toEqual([]);
      expect(rec.out).toHaveLength(1);
      expect(rec.out[0]).toContain('Live usage bundle:');
      expect(rec.out[0]).toContain('name: hoplon-live-usage-bundle');
      expect(rec.out[0]).toContain('edit loop: createHoplonEditSession');
      expect(rec.out[0]).toContain('raw-text companion: host-owned');
      expect(rec.out[0]).toContain('omitted=lock_free_degraded');
      expect(rec.out[0]).toContain('cross-launcher serialization=not_guaranteed_without_shared_distributed_provider');
      expect(rec.out[0]).toContain('os_level_writes');
      expect(rec.out[0]).toContain('strict-agent fallback policy (t-097):');
      expect(rec.out[0]).toContain('strict_agent_launcher_unavailable');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
