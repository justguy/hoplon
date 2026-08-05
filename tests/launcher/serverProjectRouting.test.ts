/**
 * tests/launcher/serverProjectRouting.test.ts — launcher server project routing.
 *
 * Proves the packaged MCP and HTTP launcher surfaces honor t-080 registered
 * project roots for engine read/search calls. The regression is the live
 * launcher-root bug: `see_codebase` used the Hoplon launcher fsRoot even when
 * a registered projectId named another root.
 */

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

interface Layout {
  launcherRoot: string;
  projectRoot: string;
}

function seedRegisteredProject(): Layout {
  const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-route-launcher-'));
  const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-route-project-'));
  fs.writeFileSync(path.join(launcherRoot, 'hello.ts'), "export const SOURCE = 'launcher';\n");
  fs.writeFileSync(path.join(projectRoot, 'hello.ts'), "export const SOURCE = 'ask';\n");
  const manager = openLauncherProjects(launcherRoot);
  manager.register({
    projectId: 'ask',
    fsRoot: projectRoot,
    engineId: 'engine-ask',
    grammarsDir: GRAMMARS_DIR,
  });
  manager.setActive('ask');
  return { launcherRoot, projectRoot };
}

function seeCodebasePayload() {
  return {
    projectId: 'ask',
    runId: 'run-route',
    correlationId: 'corr-route',
    intent: 'read_exact_text',
    mode: 'raw',
    strict: true,
    targets: [{ kind: 'file', path: 'hello.ts' }],
  };
}

function expectAskProjectBytes(value: unknown): void {
  const text = JSON.stringify(value);
  expect(text).toContain('engine-ask');
  expect(text).toContain("'ask'");
  expect(text).not.toContain("'launcher'");
}

describe('launcher server project routing', () => {
  it('keeps MCP see_codebase on the launcher root when no projects are registered', async () => {
    const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-route-default-'));
    fs.writeFileSync(path.join(launcherRoot, 'hello.ts'), "export const SOURCE = 'launcher';\n");
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runMcpServe({
      root: launcherRoot,
      grammarsDir: GRAMMARS_DIR,
      injectTransport: serverTransport,
    });
    const client = new Client(
      { name: 'project-routing-default-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: 'see_codebase',
        arguments: { ...seeCodebasePayload(), projectId: 'single-root' },
      });
      const content = (response.content as Array<{ type: string; text: string }>)[0];
      const text = content?.text ?? '';
      expect(text).toContain("'launcher'");
      expect(text).not.toContain("'ask'");
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(launcherRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('routes MCP see_codebase through the registered project root', async () => {
    const layout = seedRegisteredProject();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runMcpServe({
      root: layout.launcherRoot,
      grammarsDir: GRAMMARS_DIR,
      injectTransport: serverTransport,
    });
    const client = new Client(
      { name: 'project-routing-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const response = await client.callTool({
        name: 'see_codebase',
        arguments: seeCodebasePayload(),
      });
      const content = (response.content as Array<{ type: string; text: string }>)[0];
      const parsed = JSON.parse(content?.text ?? '{}');
      expectAskProjectBytes(parsed);
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(layout.launcherRoot, { recursive: true, force: true });
      fs.rmSync(layout.projectRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('routes HTTP /seeCodebase through the registered project root', async () => {
    const layout = seedRegisteredProject();
    const handle = await runHttpServe({
      root: layout.launcherRoot,
      grammarsDir: GRAMMARS_DIR,
      listen: false,
    });

    try {
      const response = await handle.fastify.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: seeCodebasePayload(),
      });
      expect(response.statusCode).toBe(200);
      expectAskProjectBytes(response.json());
    } finally {
      await handle.close();
      fs.rmSync(layout.launcherRoot, { recursive: true, force: true });
      fs.rmSync(layout.projectRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('keeps HTTP /seeCodebase on the launcher root when no projects are registered', async () => {
    const launcherRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-route-http-default-'));
    fs.writeFileSync(path.join(launcherRoot, 'hello.ts'), "export const SOURCE = 'launcher';\n");
    const handle = await runHttpServe({
      root: launcherRoot,
      grammarsDir: GRAMMARS_DIR,
      listen: false,
    });

    try {
      const response = await handle.fastify.inject({
        method: 'POST',
        url: '/seeCodebase',
        payload: { ...seeCodebasePayload(), projectId: 'single-root' },
      });
      expect(response.statusCode).toBe(200);
      const text = response.body;
      expect(text).toContain("'launcher'");
      expect(text).not.toContain("'ask'");
    } finally {
      await handle.close();
      fs.rmSync(launcherRoot, { recursive: true, force: true });
    }
  }, 30_000);
});
