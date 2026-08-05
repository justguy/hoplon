import { describe, expect, it } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { runHttpServe } from '../../src/hoplon/launcher/httpServe.js';
import { runMcpServe } from '../../src/hoplon/launcher/mcpServe.js';
import { openLauncherProjects } from '../../src/hoplon/launcher/projects.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');
const TARGET = 'src/shared.ts';

interface ProjectLayout { launcherRoot: string; projectARoot: string; projectBRoot: string }
interface HttpSessionResponse<T> { session: { sessionId: string }; state: string; data: T }
interface ToolResponse { content: Array<{ type: string; text: string }>; isError?: boolean }

function makeRoot(prefix: string): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function writeTarget(root: string, marker: string): void {
  fs.writeFileSync(path.join(root, TARGET), `export const marker = '${marker}';\n`);
}

function readTarget(root: string): string {
  return fs.readFileSync(path.join(root, TARGET), 'utf8');
}

function makeRegisteredLayout(): ProjectLayout {
  const launcherRoot = makeRoot('hoplon-t130-launcher-');
  const projectARoot = makeRoot('hoplon-t130-project-a-');
  const projectBRoot = makeRoot('hoplon-t130-project-b-');
  writeTarget(launcherRoot, 'launcher-original');
  writeTarget(projectARoot, 'project-a-original');
  writeTarget(projectBRoot, 'project-b-original');

  const manager = openLauncherProjects(launcherRoot);
  for (const [projectId, fsRoot] of [
    ['project-a', projectARoot],
    ['project-b', projectBRoot],
  ] as const) {
    manager.register({
      projectId,
      fsRoot,
      engineId: `engine-${projectId}`,
      grammarsDir: GRAMMARS_DIR,
    });
  }

  return { launcherRoot, projectARoot, projectBRoot };
}

function cleanup(...roots: string[]): void {
  for (const root of roots) fs.rmSync(root, { recursive: true, force: true });
}

function startHttp(root: string): Promise<Awaited<ReturnType<typeof runHttpServe>>> {
  return runHttpServe({ root, grammarsDir: GRAMMARS_DIR, listen: false });
}

function manifest(projectId: string) {
  return {
    manifestSchemaVersion: 1,
    projectId,
    runId: `run-${projectId}`,
    correlationId: `corr-${projectId}`,
    entries: [{ path: TARGET, scope: { kind: 'whole_file' } }],
  };
}

async function expectHttpState<T>(
  handle: Awaited<ReturnType<typeof runHttpServe>>,
  url: string,
  payload: unknown,
  state: string,
): Promise<HttpSessionResponse<T>> {
  const response = await handle.fastify.inject({ method: 'POST', url, payload });
  expect(response.statusCode).toBe(200);
  const body = response.json() as HttpSessionResponse<T>;
  expect(body.state).toBe(state);
  return body;
}

async function startHttpSession(
  handle: Awaited<ReturnType<typeof runHttpServe>>,
  projectId: string,
): Promise<string> {
  const started = await expectHttpState<{ engineId: string }>(
    handle,
    '/session/start',
    { manifest: manifest(projectId) },
    'created',
  );
  return started.session.sessionId;
}

async function prepareHttpSession(
  handle: Awaited<ReturnType<typeof runHttpServe>>,
  sessionId: string,
): Promise<void> {
  await expectHttpState(handle, '/session/preflight', { sessionId }, 'preflighted_pass');
  await expectHttpState(handle, '/session/createSnapshot', { sessionId }, 'snapshotted');
}

async function applyHttpEdit(
  handle: Awaited<ReturnType<typeof runHttpServe>>,
  sessionId: string,
  marker: string,
): Promise<void> {
  const content = `export const marker = '${marker}';\n`;
  const applied = await expectHttpState<
    { changedFiles: readonly string[]; bytesWritten: number }
  >(handle, '/session/applyEdits', { sessionId, proposedChanges: [{ file: TARGET, content }] }, 'edited');
  expect(applied.data.changedFiles).toEqual([TARGET]);
  expect(applied.data.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
}

async function auditHttpSession(
  handle: Awaited<ReturnType<typeof runHttpServe>>,
  sessionId: string,
): Promise<void> {
  const audited = await expectHttpState<{ result: { status: string } }>(
    handle,
    '/session/audit',
    { sessionId },
    'audited_pass',
  );
  expect(audited.data.result.status).toBe('PASS');
}

function parseToolData<T>(res: unknown): T {
  const typed = res as ToolResponse;
  expect(typed.isError).not.toBe(true);
  return JSON.parse(typed.content[0]?.text ?? '{}') as T;
}

async function callToolData<T>(
  client: Client,
  name: string,
  args: Record<string, unknown>,
): Promise<T> {
  return parseToolData<T>(await client.callTool({ name, arguments: args }));
}

async function prepareMcpSession(client: Client, sessionId: string): Promise<void> {
  for (const [name, state] of [
    ['session_preflight', 'preflighted_pass'],
    ['session_create_snapshot', 'snapshotted'],
  ] as const) {
    const body = await callToolData<HttpSessionResponse<unknown>>(client, name, { sessionId });
    expect(body.state).toBe(state);
  }
}

async function connectMcp(root: string, name: string) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  const handle = await runMcpServe({ root, grammarsDir: GRAMMARS_DIR, injectTransport: serverTransport });
  const client = new Client({ name, version: '0.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { handle, client };
}

function expectSessionIdGuidance(message: string): void {
  expect(message).toMatch(/sessionId/);
  expect(message).toMatch(/start_edit_session/);
  expect(message).toMatch(/\/session\/start/);
}

describe('t-130 launcher packaged session project routing', () => {
  it('routes concurrent HTTP sessions for registered projects to their own roots', async () => {
    const layout = makeRegisteredLayout();
    const handle = await startHttp(layout.launcherRoot);

    try {
      const sessionA = await startHttpSession(handle, 'project-a');
      const sessionB = await startHttpSession(handle, 'project-b');
      await prepareHttpSession(handle, sessionA);
      await prepareHttpSession(handle, sessionB);

      await applyHttpEdit(handle, sessionA, 'project-a-edited');
      await applyHttpEdit(handle, sessionB, 'project-b-edited');
      await auditHttpSession(handle, sessionA);
      await auditHttpSession(handle, sessionB);

      expect(readTarget(layout.projectARoot)).toBe("export const marker = 'project-a-edited';\n");
      expect(readTarget(layout.projectBRoot)).toBe("export const marker = 'project-b-edited';\n");
      expect(readTarget(layout.launcherRoot)).toBe(
        "export const marker = 'launcher-original';\n",
      );
      expect(readTarget(layout.projectARoot)).not.toContain('project-b-edited');
      expect(readTarget(layout.projectBRoot)).not.toContain('project-a-edited');
    } finally {
      await handle.close();
      cleanup(layout.launcherRoot, layout.projectARoot, layout.projectBRoot);
    }
  }, 30_000);

  it('routes MCP packaged session start/apply through the registered project root', async () => {
    const layout = makeRegisteredLayout();
    const { handle, client } = await connectMcp(
      layout.launcherRoot,
      't130-session-routing-client',
    );

    try {
      const started = await callToolData<HttpSessionResponse<{ engineId: string }>>(
        client,
        'start_edit_session',
        { manifest: JSON.stringify(manifest('project-a')) },
      );
      expect(started.state).toBe('created');
      const { sessionId } = started.session;
      await prepareMcpSession(client, sessionId);

      const content = "export const marker = 'project-a-mcp-edited';\n";
      const applied = await callToolData<
        HttpSessionResponse<{ changedFiles: readonly string[]; bytesWritten: number }>
      >(client, 'session_apply_edits', {
        sessionId,
        proposedChanges: [{ file: TARGET, content }],
      });
      expect(applied.state).toBe('edited');
      expect(applied.data.changedFiles).toEqual([TARGET]);
      expect(applied.data.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
      expect(readTarget(layout.projectARoot)).toBe(content);
      expect(readTarget(layout.launcherRoot)).toBe(
        "export const marker = 'launcher-original';\n",
      );
    } finally {
      await client.close();
      await handle.close();
      cleanup(layout.launcherRoot, layout.projectARoot, layout.projectBRoot);
    }
  }, 30_000);

  it('hcr-010: per-project sessions derive coverage from the routed engine store', async () => {
    const layout = makeRegisteredLayout();
    const handle = await startHttp(layout.launcherRoot);

    try {
      const sessionId = await startHttpSession(handle, 'project-a');
      await prepareHttpSession(handle, sessionId);

      // Smuggle an uncontracted file into project A's root after the snapshot.
      fs.writeFileSync(
        path.join(layout.projectARoot, 'src/smuggled.ts'),
        'export const evil = 666;\n',
      );
      await expectHttpState(handle, '/session/markEdited', { sessionId, files: [] }, 'edited');

      const audited = await expectHttpState<{
        result: {
          status: string;
          coverage?: {
            mode: string;
            declaredFileCount: number;
            discoveredPostSnapshotFiles: string[];
            partialReason: string | null;
          };
        };
      }>(handle, '/session/audit', { sessionId }, 'audited_block');
      expect(audited.data.result.status).toBe('BLOCK');
      expect(audited.data.result.coverage).toEqual({
        mode: 'derived',
        declaredFileCount: 0,
        discoveredPostSnapshotFiles: ['src/smuggled.ts'],
        partialReason: null,
      });
    } finally {
      await handle.close();
      cleanup(layout.launcherRoot, layout.projectARoot, layout.projectBRoot);
    }
  }, 30_000);

  it('keeps HTTP packaged sessions on the launcher root when the registry is empty', async () => {
    const launcherRoot = makeRoot('hoplon-t130-empty-registry-');
    writeTarget(launcherRoot, 'launcher-original');
    const handle = await startHttp(launcherRoot);

    try {
      const sessionId = await startHttpSession(handle, 'unregistered-project');
      await prepareHttpSession(handle, sessionId);
      await applyHttpEdit(handle, sessionId, 'launcher-edited');
      await auditHttpSession(handle, sessionId);
      expect(readTarget(launcherRoot)).toBe("export const marker = 'launcher-edited';\n");
    } finally {
      await handle.close();
      cleanup(launcherRoot);
    }
  }, 30_000);

  it('returns actionable HTTP and MCP guidance when a later session call omits sessionId', async () => {
    const launcherRoot = makeRoot('hoplon-t130-missing-session-id-');
    const httpHandle = await startHttp(launcherRoot);
    const { handle: mcpHandle, client } = await connectMcp(
      launcherRoot,
      't130-missing-session-id-client',
    );

    try {
      const httpMissing = await httpHandle.fastify.inject({
        method: 'POST',
        url: '/session/applyEdits',
        payload: { proposedChanges: [{ file: TARGET, content: '' }] },
      });
      expect(httpMissing.statusCode).toBe(400);
      const httpBody = httpMissing.json() as { error: { kind: string; message: string } };
      expect(httpBody.error.kind).toBe('invalid_request');
      expectSessionIdGuidance(httpBody.error.message);

      const mcpMissing = (await client.callTool({
        name: 'session_apply_edits',
        arguments: { proposedChanges: [{ file: TARGET, content: '' }] },
      })) as ToolResponse;
      expect(mcpMissing.isError).toBe(true);
      const mcpBody = JSON.parse(mcpMissing.content[0]?.text ?? '{}') as {
        kind: string;
        message: string;
      };
      expect(mcpBody.kind).toBe('invalid_request');
      expectSessionIdGuidance(mcpBody.message);
    } finally {
      await client.close();
      await mcpHandle.close();
      await httpHandle.close();
      cleanup(launcherRoot);
    }
  }, 30_000);
});
