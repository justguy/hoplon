/**
 * tests/launcher/httpServe.test.ts — `runHttpServe` end-to-end proof.
 *
 * Uses fastify.inject() against the launcher-mounted HTTP server to
 * prove the existing Hoplon HTTP surface is reachable through the
 * supported launcher entrypoint. The launcher constructs the real
 * Phase 1 engine (createDefaultHoplonEngine) — no mocking.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runHttpServe } from '../../src/hoplon/launcher/httpServe.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-launcher-http-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

async function postJson<T>(
  handle: Awaited<ReturnType<typeof runHttpServe>>,
  url: string,
  payload: unknown,
): Promise<{ statusCode: number; body: T }> {
  const response = await handle.fastify.inject({
    method: 'POST',
    url,
    payload,
  });
  return {
    statusCode: response.statusCode,
    body: response.json() as T,
  };
}

describe('runHttpServe', () => {
  it('mounts the Hoplon HTTP surface against a temp workspace', async () => {
    const root = makeTempWorkspace();
    const handle = await runHttpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-http-0',
      listen: false,
    });

    try {
      const health = await handle.fastify.inject({
        method: 'GET',
        url: '/health',
      });
      expect(health.statusCode).toBe(200);
      const body = health.json() as { engineId: string; adapters: Record<string, string> };
      expect(body.engineId).toBe('launcher-http-0');
      expect(body.adapters.fs).toBe('ok');
      expect(body.adapters.codeIntelligence).toBe('ok');
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns null host/port when listen:false is supplied', async () => {
    const root = makeTempWorkspace();
    const handle = await runHttpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      listen: false,
    });
    try {
      expect(handle.host).toBeNull();
      expect(handle.port).toBeNull();
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('mounts the strict agent HTTP profile when requested', async () => {
    const root = makeTempWorkspace();
    const handle = await runHttpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      listen: false,
      agentToolProfile: 'strict_agent',
    });
    try {
      expect(handle.fastify.hasRoute({ method: 'GET', url: '/health' })).toBe(true);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/packContext' })).toBe(false);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/queryStructure' })).toBe(false);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/session/markEdited' })).toBe(false);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/session/quickEdit' })).toBe(false);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/session/applyEdits' })).toBe(true);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/projects/register' })).toBe(false);
      expect(handle.fastify.hasRoute({ method: 'POST', url: '/projects/handshake' })).toBe(true);
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('hcr-009 F8: smuggled post-snapshot file cannot reach audited_pass through the launcher wiring', async () => {
    const root = makeTempWorkspace();
    const handle = await runHttpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-http-f8',
      listen: false,
    });

    try {
      const manifest = {
        manifestSchemaVersion: 1,
        projectId: 'launcher-http-f8-project',
        runId: 'launcher-http-f8-run',
        correlationId: 'launcher-http-f8-corr',
        entries: [{ path: 'src/live.ts', scope: { kind: 'whole_file' } }],
      };

      const started = await postJson<{ session: { sessionId: string }; state: string }>(
        handle,
        '/session/start',
        { manifest },
      );
      expect(started.statusCode).toBe(200);
      const sessionId = started.body.session.sessionId;

      const preflight = await postJson<{ state: string }>(handle, '/session/preflight', {
        sessionId,
      });
      expect(preflight.body.state).toBe('preflighted_pass');

      const snapshot = await postJson<{ state: string }>(handle, '/session/createSnapshot', {
        sessionId,
      });
      expect(snapshot.body.state).toBe('snapshotted');

      // Reviewer probe: smuggle an uncontracted file into the workspace AFTER
      // the snapshot, outside any session write path.
      fs.writeFileSync(path.join(root, 'src/smuggled.ts'), 'export const evil = 666;\n');

      const marked = await postJson<{ state: string }>(handle, '/session/markEdited', {
        sessionId,
        files: [],
      });
      expect(marked.body.state).toBe('edited');

      const audited = await postJson<{
        state: string;
        data: {
          result: {
            status: string;
            violations?: Array<{ kind: string; path: string }>;
            coverage?: { mode: string; discoveredPostSnapshotFiles: string[] };
          };
        };
      }>(handle, '/session/audit', { sessionId });
      expect(audited.statusCode).toBe(200);

      // The launcher-wired session must DISCOVER the smuggled file (derived
      // coverage), feed it into engine.auditDiff, and land on audited_block —
      // never audited_pass with zero checked files.
      expect(audited.body.data.result.coverage?.mode).toBe('derived');
      expect(audited.body.data.result.coverage?.discoveredPostSnapshotFiles).toContain(
        'src/smuggled.ts',
      );
      expect(audited.body.data.result.status).toBe('BLOCK');
      expect(audited.body.state).toBe('audited_block');
      expect(
        (audited.body.data.result.violations ?? []).some(
          (v) => v.kind === 'uncontracted_file' && v.path === 'src/smuggled.ts',
        ),
      ).toBe(true);
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('drives a structural session edit through the launched HTTP surface', async () => {
    const root = makeTempWorkspace();
    const file = path.join(root, 'src/live.ts');
    fs.writeFileSync(
      file,
      [
        'export function foo(): number {',
        '  return 1;',
        '}',
        '',
        'export const untouched = 2;',
        '',
      ].join('\n'),
    );
    const handle = await runHttpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-http-struct',
      listen: false,
    });

    try {
      const manifest = {
        manifestSchemaVersion: 1,
        projectId: 'launcher-http-struct-project',
        runId: 'launcher-http-struct-run',
        correlationId: 'launcher-http-struct-corr',
        entries: [{ path: 'src/live.ts', scope: { kind: 'whole_file' } }],
      };

      const started = await postJson<{ session: { sessionId: string }; state: string }>(
        handle,
        '/session/start',
        { manifest },
      );
      expect(started.statusCode).toBe(200);
      const sessionId = started.body.session.sessionId;

      const preflight = await postJson<{ state: string }>(handle, '/session/preflight', {
        sessionId,
      });
      expect(preflight.body.state).toBe('preflighted_pass');

      const snapshot = await postJson<{
        state: string;
        data: { snapshotRef: { id: string } };
      }>(handle, '/session/createSnapshot', { sessionId });
      expect(snapshot.body.state).toBe('snapshotted');
      expect(snapshot.body.data.snapshotRef.id).toMatch(/^sha256:/);

      const replacement = [
        'export function foo(): number {',
        '  return 99;',
        '}',
        '',
      ].join('\n');
      const applied = await postJson<{
        state: string;
        data: { changedFiles: string[]; changeKindCounts: { structural: number } };
      }>(handle, '/session/applyEdits', {
        sessionId,
        proposedChanges: [
          {
            kind: 'structural',
            file: 'src/live.ts',
            target: { symbol: 'foo' },
            content: replacement,
          },
        ],
      });
      expect(applied.statusCode).toBe(200);
      expect(applied.body.state).toBe('edited');
      expect(applied.body.data.changedFiles).toEqual(['src/live.ts']);
      expect(applied.body.data.changeKindCounts.structural).toBe(1);
      const onDisk = fs.readFileSync(file, 'utf8');
      expect(onDisk).toContain('return 99;');
      expect(onDisk).toContain('export const untouched = 2;');

      const audited = await postJson<{
        state: string;
        data: { result: { status: string } };
      }>(handle, '/session/audit', { sessionId });
      expect(audited.statusCode).toBe(200);
      expect(audited.body.state).toBe('audited_pass');
      expect(audited.body.data.result.status).toBe('PASS');
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
