/**
 * tests/launcher/mcpServe.test.ts — `runMcpServe` end-to-end proof.
 *
 * Uses the MCP SDK's InMemoryTransport pair to drive a real MCP client
 * against a launcher-booted server. The launcher constructs the actual
 * Phase 1 engine (createDefaultHoplonEngine) — no mocking.
 *
 * Proves:
 * 1. runMcpServe constructs + connects successfully against a temp workspace.
 * 2. `tools/list` returns the MCP tool registry the wrapper advertises —
 *    the engine tools plus packaged session/start tools and launcher project
 *    handshake/lifecycle tools surfaced by the launcher-owned registries.
 * 3. `tools/call health` returns a real EngineHealth payload.
 * 4. The launcher-backed MCP path answers a real packaged session round-trip,
 *    not only `tools/list`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';

import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import { runMcpServe } from '../../src/hoplon/launcher/mcpServe.js';
import { runProjectCommand } from '../../src/hoplon/launcher/projectCli.js';
import { saveProjectsStore } from '../../src/hoplon/launcher/projectsStore.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '../..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor/grammars');

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

function makeTempWorkspace(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-launcher-mcp-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  return root;
}

function parseData<T>(res: unknown): T {
  const typed = res as ToolResponse;
  expect(typed.isError).not.toBe(true);
  return JSON.parse(typed.content[0]?.text ?? '{}') as T;
}

function parseError<T>(res: unknown): T {
  const typed = res as ToolResponse;
  expect(typed.isError).toBe(true);
  return JSON.parse(typed.content[0]?.text ?? '{}') as T;
}

describe('runMcpServe', () => {
  it('serves the Hoplon engine through the MCP protocol over an injected transport', async () => {
    const root = makeTempWorkspace();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-mcp-0',
      injectTransport: serverTransport,
    });

    const client = new Client(
      { name: 'launcher-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const toolsList = await client.listTools();
      const names = toolsList.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'audit_diff',
          'clear_semantic_overlay',
          'compute_minimal_patch',
          'create_snapshot',
          'describe_capabilities',
          'describe_project',
          'dry_run',
          'extract_structural_template',
          'find_referencing_symbols',
          'find_syntax_node',
          'get_relevant_tests',
          'health',
          'index_semantic_corpus',
          'pack_context',
          'preflight',
          // t-083+ project lifecycle / handshake / policy tools (now exposed
          // in the launcher MCP serve since t-089 wires launcherRoot +
          // snapshotStore through `runMcpServe`).
          'projects_handshake',
          'projects_policy_audit',
          'projects_policy_summary',
          'projects_prune',
          'projects_renew',
          'projects_revoke',
          'query_structure',
          'refresh_semantic_overlay',
          'revert_uncontracted',
          'search_symbols',
          'see_codebase',
          'semantic_search',
          'session_apply_edits',
          'session_audit',
          'session_close',
          'session_create_snapshot',
          'session_dry_run',
          'session_extract_rollback_template',
          'session_get_closeout_proof_bundle',
          'session_get_repair_context',
          'session_inspect',
          'session_list',
          'session_mark_edited',
          'session_preflight',
          'session_quick_edit',
          'session_revert',
          'session_review',
          'session_stage_content',
          'session_target_first_scoped_edit',
          'session_verify_behavior',
          'start_edit_session',
        ].sort(),
      );

      const healthResult = await client.callTool({ name: 'health', arguments: {} });
      const parsed = parseData<{ engineId: string; adapters: Record<string, string> }>(healthResult);
      expect(parsed.engineId).toBe('launcher-mcp-0');
      expect(parsed.adapters.fs).toBe('ok');
      expect(parsed.adapters.codeIntelligence).toBe('ok');

      const content = 'export const live = true;\n';
      const manifest = JSON.stringify({
        manifestSchemaVersion: 1,
        projectId: 'launcher-mcp-project',
        runId: 'launcher-mcp-run',
        correlationId: 'launcher-mcp-corr',
        entries: [{ path: 'src/live.ts', scope: { kind: 'whole_file' } }],
      });

      const started = parseData<{ session: { sessionId: string }; state: string }>(
        await client.callTool({
          name: 'start_edit_session',
          arguments: { manifest },
        }),
      );
      expect(started.state).toBe('created');
      const sessionId = started.session.sessionId;

      const preflight = parseData<{ state: string }>(
        await client.callTool({ name: 'session_preflight', arguments: { sessionId } }),
      );
      expect(preflight.state).toBe('preflighted_pass');

      const snapshot = parseData<{ state: string; data: { snapshotRef: { id: string } } }>(
        await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } }),
      );
      expect(snapshot.state).toBe('snapshotted');
      expect(snapshot.data.snapshotRef.id).toMatch(/^sha256:/);

      const applied = parseData<{
        state: string;
        data: { changedFiles: string[]; bytesWritten: number };
      }>(
        await client.callTool({
          name: 'session_apply_edits',
          arguments: {
            sessionId,
            proposedChanges: [{ file: 'src/live.ts', content }],
          },
        }),
      );
      expect(applied.state).toBe('edited');
      expect(applied.data.changedFiles).toEqual(['src/live.ts']);
      expect(applied.data.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
      expect(fs.readFileSync(path.join(root, 'src/live.ts'), 'utf8')).toBe(content);

      const audited = parseData<{ state: string; data: { result: { status: string } } }>(
        await client.callTool({ name: 'session_audit', arguments: { sessionId } }),
      );
      expect(audited.state).toBe('audited_pass');
      expect(audited.data.result.status).toBe('PASS');

      const closed = parseData<{ state: string; data: { closed: boolean } }>(
        await client.callTool({ name: 'session_close', arguments: { sessionId } }),
      );
      expect(closed.state).toBe('closed');
      expect(closed.data.closed).toBe(true);
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('reports the chosen transport on the lifecycle handle', async () => {
    const root = makeTempWorkspace();
    const [serverTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      injectTransport: serverTransport,
    });
    try {
      expect(handle.transport).toBe('injected');
      expect(handle.port).toBeNull();
    } finally {
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('refreshes durable project registrations before MCP handshake routing', async () => {
    const root = makeTempWorkspace();
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'hoplon-late-project-'));
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      injectTransport: serverTransport,
    });
    const client = new Client(
      { name: 'launcher-refresh-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const before = parseError<{ kind: string }>(
        await client.callTool({
          name: 'projects_handshake',
          arguments: { projectId: 'late', folder: 'src' },
        }),
      );
      expect(before.kind).toBe('unknown_project');

      const registry = createProjectRegistry();
      const record = registry.register({ projectId: 'late', fsRoot: projectRoot });
      saveProjectsStore(path.join(root, '.hoplon/projects.json'), {
        projects: [record],
        activeProjectId: null,
      });

      const after = parseError<{ kind: string }>(
        await client.callTool({
          name: 'projects_handshake',
          arguments: { projectId: 'late', folder: 'src' },
        }),
      );
      expect(after.kind).toBe('no_folder_policy');
      expect((after as { help?: string }).help).toContain('--folder-policy-file');
      expect((after as { help?: string }).help).toContain(
        'trusted host-shell authority',
      );
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  }, 30_000);

  it('serves the strict agent MCP profile over an injected transport', async () => {
    const root = makeTempWorkspace();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-mcp-strict-0',
      injectTransport: serverTransport,
      agentToolProfile: 'strict_agent',
    });
    const client = new Client(
      { name: 'launcher-strict-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const toolsList = await client.listTools();
      const names = toolsList.tools.map((t) => t.name).sort();
      expect(names).toEqual(
        [
          'clear_semantic_overlay',
          'describe_capabilities',
          'describe_project',
          'find_syntax_node',
          'get_relevant_tests',
          'health',
          'index_semantic_corpus',
          'projects_handshake',
          'projects_policy_audit',
          'projects_policy_summary',
          'projects_prune',
          'projects_renew',
          'projects_revoke',
          'refresh_semantic_overlay',
          'search_symbols',
          'see_codebase',
          'semantic_search',
          'session_apply_edits',
          'session_audit',
          'session_close',
          'session_create_snapshot',
          'session_dry_run',
          'session_extract_rollback_template',
          'session_get_closeout_proof_bundle',
          'session_get_repair_context',
          'session_inspect',
          'session_list',
          'session_preflight',
          'session_revert',
          'session_review',
          'session_stage_content',
          'session_target_first_scoped_edit',
          'session_verify_behavior',
          'start_edit_session',
        ].sort(),
      );
      expect(names).not.toContain('pack_context');
      expect(names).not.toContain('query_structure');
      expect(names).not.toContain('extract_structural_template');
      expect(names).not.toContain('session_mark_edited');
      expect(names).not.toContain('session_quick_edit');
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('returns project discovery guidance on unknown projectId MCP read failures', async () => {
    const root = makeTempWorkspace();
    const registeredRoot = path.join(root, 'registered-a');
    fs.mkdirSync(path.join(registeredRoot, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(registeredRoot, 'src/live.ts'),
      'export const routed = true;\n',
    );
    const registered = runProjectCommand(
      { root, grammarsDir: GRAMMARS_DIR },
      {
        kind: 'register',
        projectId: 'Registered-A',
        fsRoot: registeredRoot,
        grammarsDir: GRAMMARS_DIR,
      },
    );
    expect(registered.ok).toBe(true);

    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-mcp-project-guidance',
      injectTransport: serverTransport,
    });
    const client = new Client(
      { name: 'launcher-project-guidance-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    const seeArgs = {
      runId: 'project-guidance-run',
      correlationId: 'project-guidance-corr',
      intent: 'read_exact_text',
      targets: [{ kind: 'file', path: 'src/live.ts' }],
      mode: 'raw',
      strict: true,
    };

    try {
      const unknown = parseError<{
        kind: string;
        registeredProjectIds: string[];
        requestedProjectId: string;
        help: string;
      }>(
        await client.callTool({
          name: 'see_codebase',
          arguments: { ...seeArgs, projectId: 'missing-project' },
        }),
      );
      expect(unknown.kind).toBe('unknown_project');
      expect(unknown.requestedProjectId).toBe('missing-project');
      expect(unknown.registeredProjectIds).toEqual(['Registered-A']);
      expect(unknown.help).toContain('registeredProjectIds');
      expect(unknown.help).toContain('hoplon project register');
      expect(unknown.help).toContain('MCP agents cannot register projects');
      expect(unknown.help).toContain('trusted host-shell authority');

      const pathMismatch = parseError<{
        kind: string;
        registeredProjectIds: string[];
        projectIdLooksLikePath: boolean;
        help: string;
      }>(
        await client.callTool({
          name: 'see_codebase',
          arguments: { ...seeArgs, projectId: registeredRoot },
        }),
      );
      expect(pathMismatch.kind).toBe('unknown_project');
      expect(pathMismatch.registeredProjectIds).toEqual(['Registered-A']);
      expect(pathMismatch.projectIdLooksLikePath).toBe(true);
      expect(pathMismatch.help).toContain('not a filesystem path');

      const semanticUnknown = parseError<{
        kind: string;
        registeredProjectIds: string[];
        requestedProjectId: string;
        help: string;
      }>(
        await client.callTool({
          name: 'semantic_search',
          arguments: {
            correlationId: 'project-guidance-semantic-corr',
            projectId: 'registered-a',
            query: 'routed export',
            topK: 3,
          },
        }),
      );
      expect(semanticUnknown.kind).toBe('unknown_project');
      expect(semanticUnknown.requestedProjectId).toBe('registered-a');
      expect(semanticUnknown.registeredProjectIds).toEqual(['Registered-A']);
      expect(semanticUnknown.help).toContain('registeredProjectIds');

      const retry = parseData<{ ok: boolean }>(
        await client.callTool({
          name: 'see_codebase',
          arguments: { ...seeArgs, projectId: 'Registered-A' },
        }),
      );
      expect(retry.ok).toBe(true);

      const indexedRecovery = parseData<{
        advisory: true;
        status: string;
        providerAvailable: boolean;
        freshness: string;
        degradationReasons: string[];
        suggestions: Array<{ kind: string }>;
      }>(
        await client.callTool({
          name: 'semantic_search',
          arguments: {
            correlationId: 'project-guidance-semantic-indexed-corr',
            projectId: 'Registered-A',
            query: 'routed export',
            topK: 3,
          },
        }),
      );
      expect(indexedRecovery.advisory).toBe(true);
      expect(indexedRecovery.status).toBe('UNAVAILABLE');
      expect(indexedRecovery.providerAvailable).toBe(false);
      expect(indexedRecovery.freshness).toBe('unavailable');
      expect(indexedRecovery.degradationReasons).toEqual([
        'provider_not_bound',
        'no_indexed_corpus',
      ]);
      expect(indexedRecovery.suggestions.map((s) => s.kind)).toEqual([
        'provider_binding',
        'no_indexed_corpus',
        'corpus_indexing',
      ]);
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('hcr-009 F8: smuggled post-snapshot file cannot reach audited_pass through the launcher wiring', async () => {
    const root = makeTempWorkspace();
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-mcp-f8',
      injectTransport: serverTransport,
    });
    const client = new Client(
      { name: 'launcher-f8-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const manifest = JSON.stringify({
        manifestSchemaVersion: 1,
        projectId: 'launcher-mcp-f8-project',
        runId: 'launcher-mcp-f8-run',
        correlationId: 'launcher-mcp-f8-corr',
        entries: [{ path: 'src/live.ts', scope: { kind: 'whole_file' } }],
      });
      const started = parseData<{ session: { sessionId: string }; state: string }>(
        await client.callTool({ name: 'start_edit_session', arguments: { manifest } }),
      );
      const sessionId = started.session.sessionId;
      parseData(
        await client.callTool({ name: 'session_preflight', arguments: { sessionId } }),
      );
      parseData(
        await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } }),
      );

      // Reviewer probe: smuggle an uncontracted file into the workspace AFTER
      // the snapshot, outside any session write path.
      fs.writeFileSync(path.join(root, 'src/smuggled.ts'), 'export const evil = 666;\n');

      const marked = parseData<{ state: string }>(
        await client.callTool({
          name: 'session_mark_edited',
          arguments: { sessionId, files: [] },
        }),
      );
      expect(marked.state).toBe('edited');

      const audited = parseData<{
        state: string;
        data: {
          result: {
            status: string;
            violations?: Array<{ kind: string; path: string }>;
            coverage?: { mode: string; discoveredPostSnapshotFiles: string[] };
          };
        };
      }>(await client.callTool({ name: 'session_audit', arguments: { sessionId } }));

      // The launcher-wired session must DISCOVER the smuggled file (derived
      // coverage), feed it into engine.auditDiff, and land on audited_block —
      // never audited_pass with zero checked files.
      expect(audited.data.result.coverage?.mode).toBe('derived');
      expect(audited.data.result.coverage?.discoveredPostSnapshotFiles).toContain(
        'src/smuggled.ts',
      );
      expect(audited.data.result.status).toBe('BLOCK');
      expect(audited.state).toBe('audited_block');
      expect(
        (audited.data.result.violations ?? []).some(
          (v) => v.kind === 'uncontracted_file' && v.path === 'src/smuggled.ts',
        ),
      ).toBe(true);
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);

  it('drives a structural session edit through the launched MCP surface', async () => {
    const root = makeTempWorkspace();
    fs.writeFileSync(
      path.join(root, 'src/live.ts'),
      [
        'export function foo(): number {',
        '  return 1;',
        '}',
        '',
        'export const untouched = 2;',
        '',
      ].join('\n'),
    );
    const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();

    const handle = await runMcpServe({
      root,
      grammarsDir: GRAMMARS_DIR,
      engineId: 'launcher-mcp-struct',
      injectTransport: serverTransport,
    });

    const client = new Client(
      { name: 'launcher-test-client', version: '0.0.0' },
      { capabilities: {} },
    );
    await client.connect(clientTransport);

    try {
      const manifest = JSON.stringify({
        manifestSchemaVersion: 1,
        projectId: 'launcher-mcp-struct-project',
        runId: 'launcher-mcp-struct-run',
        correlationId: 'launcher-mcp-struct-corr',
        entries: [{ path: 'src/live.ts', scope: { kind: 'whole_file' } }],
      });

      const started = parseData<{ session: { sessionId: string }; state: string }>(
        await client.callTool({
          name: 'start_edit_session',
          arguments: { manifest },
        }),
      );
      expect(started.state).toBe('created');
      const sessionId = started.session.sessionId;

      const preflight = parseData<{ state: string }>(
        await client.callTool({ name: 'session_preflight', arguments: { sessionId } }),
      );
      expect(preflight.state).toBe('preflighted_pass');

      const snapshot = parseData<{ state: string; data: { snapshotRef: { id: string } } }>(
        await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } }),
      );
      expect(snapshot.state).toBe('snapshotted');
      expect(snapshot.data.snapshotRef.id).toMatch(/^sha256:/);

      const replacement = [
        'export function foo(): number {',
        '  return 99;',
        '}',
        '',
      ].join('\n');
      const applied = parseData<{
        state: string;
        data: { changedFiles: string[]; changeKindCounts: { structural: number } };
      }>(
        await client.callTool({
          name: 'session_apply_edits',
          arguments: {
            sessionId,
            proposedChanges: [
              {
                kind: 'structural',
                file: 'src/live.ts',
                target: { symbol: 'foo' },
                content: replacement,
              },
            ],
          },
        }),
      );
      expect(applied.state).toBe('edited');
      expect(applied.data.changedFiles).toEqual(['src/live.ts']);
      expect(applied.data.changeKindCounts.structural).toBe(1);
      const onDisk = fs.readFileSync(path.join(root, 'src/live.ts'), 'utf8');
      expect(onDisk).toContain('return 99;');
      expect(onDisk).toContain('export const untouched = 2;');

      const audited = parseData<{ state: string; data: { result: { status: string } } }>(
        await client.callTool({ name: 'session_audit', arguments: { sessionId } }),
      );
      expect(audited.state).toBe('audited_pass');
      expect(audited.data.result.status).toBe('PASS');
    } finally {
      await client.close();
      await handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    }
  }, 30_000);
});
