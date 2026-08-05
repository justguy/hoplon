/**
 * tests/transport/mcp.session.test.ts — packaged session surface proof for MCP.
 *
 * Proves that the shipped ordered loop (`createHoplonEditSession`) is exposed
 * end-to-end through MCP tool calls and that the t-062 contract holds:
 *
 *   1. tools/list surfaces every session_* tool next to the engine tools.
 *   2. PASS branch: start → preflight → createSnapshot → markEdited → audit
 *      round-trips through the in-memory MCP transport and advances session
 *      state on the server side.
 *   3. BLOCK branch: a BLOCK audit transitions the session to audited_block,
 *      revert + extract_rollback_template round-trip, and the ordered loop
 *      ends at rollback_extracted — no second session model exists.
 *   4. Error envelopes carry a `kind` (session_not_found / invalid_request)
 *      so agents can route transport-level errors independently.
 *   5. session_list returns the live registry snapshot and close evicts.
 *
 * Uses a mock engine so the test is hermetic; the real engine integration is
 * proved separately in tests/session/integration.test.ts and the selfhost
 * proofs (t-048/t-049).
 */

import { describe, it, expect } from 'vitest';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';

import { createHoplonMcpServer } from '../../src/hoplon/mcp/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type { SessionState } from '../../src/hoplon/session/types.js';
import {
  MANIFEST,
  BLOCK_AUDIT,
  PASS_AUDIT,
  ROLLBACK_TEMPLATE,
  SNAPSHOT_REF_ID,
  makeMockEngine,
} from '../session/helpers.js';

interface ToolResponse {
  content: Array<{ type: string; text: string }>;
  isError?: boolean;
}

async function buildClient(auditResult = PASS_AUDIT, fs?: HoplonFsAdapter) {
  const engine = makeMockEngine({
    auditDiff: async () => auditResult,
  });
  const registry = createSessionRegistry({
    engine,
    ...(fs !== undefined ? { fs } : {}),
  });
  const server = createHoplonMcpServer({ engine, sessionRegistry: registry });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: 'session-test-client', version: '1.0.0' }, { capabilities: {} });
  await client.connect(clientTransport);
  return { client, registry, fs };
}

function parseData<T>(res: unknown): T {
  const r = res as ToolResponse;
  expect(r.isError).toBeFalsy();
  return JSON.parse(r.content[0].text) as T;
}

describe('MCP session transport surface (t-062)', () => {
  it('tools/list includes every session_* tool alongside engine tools', async () => {
    const { client, registry } = await buildClient();
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    expect(names).toEqual(
      expect.arrayContaining([
        'start_edit_session',
        'session_preflight',
        'session_create_snapshot',
        'session_dry_run',
        'session_apply_edits',
        'session_mark_edited',
        'session_audit',
        'session_revert',
        'session_extract_rollback_template',
        'session_get_repair_context',
        'session_get_closeout_proof_bundle',
        'session_quick_edit',
        'session_target_first_scoped_edit',
        'session_inspect',
        'session_close',
        'session_list',
        // spot-check engine tool to prove coexistence
        'health',
      ]),
    );
    registry.dispose();
  });

  it('PASS branch: start → preflight → createSnapshot → markEdited → audit', async () => {
    const { client, registry } = await buildClient(PASS_AUDIT);

    const startRes = await client.callTool({
      name: 'start_edit_session',
      arguments: { manifest: MANIFEST },
    });
    const startData = parseData<{
      session: { sessionId: string };
      state: SessionState;
    }>(startRes);
    const sessionId = startData.session.sessionId;
    expect(startData.state).toBe('created');

    const preflight = parseData<{ state: SessionState }>(
      await client.callTool({ name: 'session_preflight', arguments: { sessionId } }),
    );
    expect(preflight.state).toBe('preflighted_pass');

    const snap = parseData<{ state: SessionState; data: { snapshotRef: { id: string } } }>(
      await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } }),
    );
    expect(snap.state).toBe('snapshotted');
    expect(snap.data.snapshotRef.id).toMatch(/^sha256:/);

    const marked = parseData<{
      state: SessionState;
      data: { overlayRefresh: { status: string; inputSource: string } };
    }>(
      await client.callTool({
        name: 'session_mark_edited',
        arguments: { sessionId, files: ['src/foo.ts'] },
      }),
    );
    expect(marked.state).toBe('edited');
    expect(marked.data.overlayRefresh.status).toBe('UNAVAILABLE');
    expect(marked.data.overlayRefresh.inputSource).toBe('failure_mask');

    const audit = parseData<{
      state: SessionState;
      data: { result: { status: string } };
    }>(await client.callTool({ name: 'session_audit', arguments: { sessionId } }));
    expect(audit.state).toBe('audited_pass');
    expect(audit.data.result.status).toBe('PASS');

    // Session still lives after audit — list surfaces it; close evicts it.
    const list = parseData<{ sessions: Array<{ sessionId: string }> }>(
      await client.callTool({ name: 'session_list', arguments: {} }),
    );
    expect(list.sessions.map((s) => s.sessionId)).toContain(sessionId);

    const closed = parseData<{ state: SessionState; data: { closed: boolean } }>(
      await client.callTool({ name: 'session_close', arguments: { sessionId } }),
    );
    expect(closed.state).toBe('closed');
    expect(closed.data.closed).toBe(true);
    expect(registry.get(sessionId)).toBeNull();

    registry.dispose();
  });

  it('session_quick_edit runs the supervised one-call edit path and leaves no live session', async () => {
    const fs = createMemFsAdapter();
    const { client, registry } = await buildClient(PASS_AUDIT, fs);
    const content = 'export const quick = true;\n';

    const quick = parseData<{
      outcome: string;
      sessionId: string;
      finalState: SessionState;
      changedFiles: string[];
      auditResult?: { status: string };
      applyEdits?: { bytesWritten: number };
    }>(
      await client.callTool({
        name: 'session_quick_edit',
        arguments: {
          manifest: MANIFEST,
          proposedChanges: [{ file: 'src/foo.ts', content }],
        },
      }),
    );

    expect(quick.outcome).toBe('pass');
    expect(quick.finalState).toBe('closed');
    expect(quick.changedFiles).toEqual(['src/foo.ts']);
    expect(quick.auditResult?.status).toBe('PASS');
    expect(quick.applyEdits?.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(content);

    const list = parseData<{ sessions: Array<{ sessionId: string }> }>(
      await client.callTool({ name: 'session_list', arguments: {} }),
    );
    expect(list.sessions.map((session) => session.sessionId)).not.toContain(quick.sessionId);

    registry.dispose();
  });

  it('accepts a JSON-string manifest on start_edit_session', async () => {
    const { client, registry } = await buildClient(PASS_AUDIT);

    const startRes = await client.callTool({
      name: 'start_edit_session',
      arguments: { manifest: JSON.stringify(MANIFEST) },
    });
    const startData = parseData<{
      session: { sessionId: string };
      state: SessionState;
    }>(startRes);

    expect(startData.state).toBe('created');
    expect(startData.session.sessionId).toMatch(/^hoplon-session-/);

    registry.dispose();
  });

  it('BLOCK branch: audit BLOCK → revert → extract_rollback_template', async () => {
    const { client, registry } = await buildClient(BLOCK_AUDIT);

    const start = parseData<{ session: { sessionId: string } }>(
      await client.callTool({ name: 'start_edit_session', arguments: { manifest: MANIFEST } }),
    );
    const sessionId = start.session.sessionId;

    await client.callTool({ name: 'session_preflight', arguments: { sessionId } });
    await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } });
    await client.callTool({
      name: 'session_mark_edited',
      arguments: { sessionId, files: ['src/foo.ts'] },
    });

    const audit = parseData<{ state: SessionState; data: { result: { status: string } } }>(
      await client.callTool({ name: 'session_audit', arguments: { sessionId } }),
    );
    expect(audit.state).toBe('audited_block');
    expect(audit.data.result.status).toBe('BLOCK');

    const revert = parseData<{ state: SessionState; data: { result: { reverted: string[] } } }>(
      await client.callTool({ name: 'session_revert', arguments: { sessionId } }),
    );
    expect(revert.state).toBe('reverted');
    expect(revert.data.result.reverted).toEqual(['src/foo.ts']);

    const template = parseData<{
      state: SessionState;
      data: { template: { files: Array<{ path: string }> } };
    }>(
      await client.callTool({
        name: 'session_extract_rollback_template',
        arguments: { sessionId },
      }),
    );
    expect(template.state).toBe('rollback_extracted');
    expect(template.data.template.files[0]?.path).toBe('src/foo.ts');

    registry.dispose();
  });

  it('session_not_found and invalid_request are returned as kinded tool errors', async () => {
    const { client, registry } = await buildClient();

    const missing = (await client.callTool({
      name: 'session_preflight',
      arguments: { sessionId: 'ghost-session' },
    })) as ToolResponse;
    expect(missing.isError).toBe(true);
    const missingBody = JSON.parse(missing.content[0].text) as { kind: string; sessionId: string };
    expect(missingBody.kind).toBe('session_not_found');
    expect(missingBody.sessionId).toBe('ghost-session');

    const bad = (await client.callTool({
      name: 'session_preflight',
      arguments: { sessionId: '' },
    })) as ToolResponse;
    expect(bad.isError).toBe(true);
    const badBody = JSON.parse(bad.content[0].text) as { kind: string };
    expect(badBody.kind).toBe('invalid_request');

    registry.dispose();
  });

  it('duplicate explicit sessionId on start_edit_session is rejected as invalid_request', async () => {
    const { client, registry } = await buildClient();

    const first = parseData<{ session: { sessionId: string } }>(
      await client.callTool({
        name: 'start_edit_session',
        arguments: {
          manifest: MANIFEST,
          sessionId: 'hoplon-session-fixed',
        },
      }),
    );
    expect(first.session.sessionId).toBe('hoplon-session-fixed');

    const duplicate = (await client.callTool({
      name: 'start_edit_session',
      arguments: {
        manifest: { ...MANIFEST, runId: 'run-session-duplicate' },
        sessionId: 'hoplon-session-fixed',
      },
    })) as ToolResponse;
    expect(duplicate.isError).toBe(true);
    const duplicateBody = JSON.parse(duplicate.content[0].text) as {
      kind: string;
      sessionId?: string;
    };
    expect(duplicateBody.kind).toBe('invalid_request');
    expect(duplicateBody.sessionId).toBe('hoplon-session-fixed');

    registry.dispose();
  });

  it('start_edit_session rejects an invalid priorRepairContext as invalid_request', async () => {
    const { client, registry } = await buildClient();

    const invalid = (await client.callTool({
      name: 'start_edit_session',
      arguments: {
        manifest: MANIFEST,
        priorRepairContext: {
          repairContextSchemaVersion: 1,
          correlationId: MANIFEST.correlationId,
          projectId: MANIFEST.projectId,
          runId: MANIFEST.runId,
          failedAttempt: {
            sessionId: 'hoplon-session-prev',
            attemptNumber: 1,
            snapshotRef: SNAPSHOT_REF_ID,
            failedAtMs: Date.UTC(2026, 3, 20, 12, 0, 0),
            executionId: null,
            attemptId: null,
            auditRef: null,
          },
          auditResult: PASS_AUDIT,
          rollbackTemplate: ROLLBACK_TEMPLATE,
          priorSessionHistory: [
            { op: 'created', fromState: 'created', toState: 'created', timestampMs: 1 },
          ],
          nextAttempt: {
            attemptNumber: 7,
            baselineSnapshotRef: 'sha256:wrong',
          },
          generatedAt: '2026-04-20T12:00:00.000Z',
        },
      },
    })) as ToolResponse;
    expect(invalid.isError).toBe(true);
    const invalidBody = JSON.parse(invalid.content[0].text) as { kind: string };
    expect(invalidBody.kind).toBe('invalid_request');

    registry.dispose();
  });

  it('session_apply_edits writes through the adapter and advances to edited (t-063)', async () => {
    const fs = createMemFsAdapter();
    const { client, registry } = await buildClient(PASS_AUDIT, fs);

    const start = parseData<{ session: { sessionId: string } }>(
      await client.callTool({ name: 'start_edit_session', arguments: { manifest: MANIFEST } }),
    );
    const sessionId = start.session.sessionId;

    await client.callTool({ name: 'session_preflight', arguments: { sessionId } });
    await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } });

    const content = 'export const applied = true;\n';
    const applied = parseData<{
      state: SessionState;
      data: { changedFiles: string[]; bytesWritten: number };
    }>(
      await client.callTool({
        name: 'session_apply_edits',
        arguments: {
          sessionId,
          proposedChanges: [{ file: 'src/foo.ts', content }],
        },
      }),
    );
    expect(applied.state).toBe('edited');
    expect(applied.data.changedFiles).toEqual(['src/foo.ts']);
    expect(applied.data.bytesWritten).toBe(Buffer.byteLength(content, 'utf8'));
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(content);

    registry.dispose();
  });

  it('session_apply_edits errors as missing_prerequisite when no fs adapter was injected', async () => {
    const { client, registry } = await buildClient();

    const start = parseData<{ session: { sessionId: string } }>(
      await client.callTool({ name: 'start_edit_session', arguments: { manifest: MANIFEST } }),
    );
    const sessionId = start.session.sessionId;
    await client.callTool({ name: 'session_preflight', arguments: { sessionId } });
    await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } });

    const bad = (await client.callTool({
      name: 'session_apply_edits',
      arguments: {
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content: 'x' }],
      },
    })) as ToolResponse;
    expect(bad.isError).toBe(true);
    const body = JSON.parse(bad.content[0].text) as { kind: string };
    expect(body.kind).toBe('missing_prerequisite');

    registry.dispose();
  });

  it('session_apply_edits accepts patch variants and reports per-kind counts (t-071)', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'alpha\nbeta\ngamma\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));
    const { client, registry } = await buildClient(PASS_AUDIT, fs);

    const start = parseData<{ session: { sessionId: string } }>(
      await client.callTool({ name: 'start_edit_session', arguments: { manifest: MANIFEST } }),
    );
    const sessionId = start.session.sessionId;
    await client.callTool({ name: 'session_preflight', arguments: { sessionId } });
    await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } });

    const applied = parseData<{
      state: SessionState;
      data: {
        changedFiles: string[];
        bytesWritten: number;
        changeKindCounts: { full_file: number; patch: number; structural: number };
      };
    }>(
      await client.callTool({
        name: 'session_apply_edits',
        arguments: {
          sessionId,
          proposedChanges: [
            {
              kind: 'patch',
              file: 'src/foo.ts',
              hunks: [
                { search: 'alpha', replace: 'ALPHA' },
                { search: 'gamma', replace: 'GAMMA' },
              ],
            },
          ],
        },
      }),
    );
    expect(applied.state).toBe('edited');
    expect(applied.data.changedFiles).toEqual(['src/foo.ts']);
    expect(applied.data.changeKindCounts).toEqual({
      full_file: 0,
      patch: 1,
      structural: 0,
    });
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
      'ALPHA\nbeta\nGAMMA\n',
    );

    registry.dispose();
  });

  it('session_target_first_scoped_edit previews a manifest draft and edit slice', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/foo.ts', new TextEncoder().encode('one\ntwo\nthree\n'));
    const { client, registry } = await buildClient(PASS_AUDIT, fs);

    const preview = parseData<{
      state: SessionState;
      session: { sessionId: string; projectId: string; runId: string };
      data: {
        result: {
          status: string;
          manifestDraft: {
            requiresConfirmation: boolean;
            manifest: { entries: Array<{ path: string; scope: unknown }> };
          };
          editSlice?: { path: string; content: string; startLine: number; endLine: number };
          proofPlan: { phases: string[] };
        };
      };
    }>(
      await client.callTool({
        name: 'session_target_first_scoped_edit',
        arguments: {
          projectId: 'proj-session',
          runId: 'run-session-1',
          correlationId: 'corr-session-1',
          target: { kind: 'symbol', file: 'src/foo.ts', symbol: 'foo' },
          editSlice: { startLine: 2, endLine: 2 },
          apply: false,
        },
      }),
    );

    expect(preview.state).toBe('closed');
    expect(preview.session.sessionId).toBe('preview');
    expect(preview.session.projectId).toBe('proj-session');
    expect(preview.data.result.status).toBe('preview');
    expect(preview.data.result.manifestDraft.requiresConfirmation).toBe(true);
    expect(preview.data.result.manifestDraft.manifest.entries).toEqual([
      { path: 'src/foo.ts', scope: { kind: 'symbols', symbols: ['foo'] } },
    ]);
    expect(preview.data.result.editSlice).toMatchObject({
      path: 'src/foo.ts',
      startLine: 2,
      endLine: 2,
      content: 'two\n',
    });
    expect(preview.data.result.proofPlan.phases).toContain(
      'await_manifest_confirmation',
    );

    registry.dispose();
  });

  it('session_target_first_scoped_edit apply requires acceptedManifest', async () => {
    const fs = createMemFsAdapter();
    const { client, registry } = await buildClient(PASS_AUDIT, fs);

    const bad = (await client.callTool({
      name: 'session_target_first_scoped_edit',
      arguments: {
        projectId: 'proj-session',
        runId: 'run-session-1',
        correlationId: 'corr-session-1',
        target: { kind: 'file', path: 'src/foo.ts' },
        apply: true,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;\n' }],
      },
    })) as ToolResponse;
    expect(bad.isError).toBe(true);
    const body = JSON.parse(bad.content[0].text) as { kind: string; message: string };
    expect(body.kind).toBe('invalid_request');
    expect(body.message).toContain('acceptedManifest');

    registry.dispose();
  });

  it('session_target_first_scoped_edit apply delegates to quickEdit without leaving a live session', async () => {
    const fs = createMemFsAdapter();
    const { client, registry } = await buildClient(PASS_AUDIT, fs);

    const applied = parseData<{
      state: SessionState;
      data: {
        result: {
          status: string;
          quickEditResult?: { outcome?: string; finalState?: SessionState; changedFiles?: string[] };
        };
      };
    }>(
      await client.callTool({
        name: 'session_target_first_scoped_edit',
        arguments: {
          projectId: 'proj-session',
          runId: 'run-session-1',
          correlationId: 'corr-session-1',
          target: { kind: 'file', path: 'src/foo.ts' },
          apply: true,
          acceptedManifest: MANIFEST,
          proposedChanges: [{ file: 'src/foo.ts', content: 'export const x = 1;\n' }],
        },
      }),
    );

    expect(applied.state).toBe('closed');
    expect(applied.data.result.status).toBe('applied');
    expect(applied.data.result.quickEditResult?.outcome).toBe('pass');
    expect(applied.data.result.quickEditResult?.finalState).toBe('closed');
    expect(applied.data.result.quickEditResult?.changedFiles).toEqual(['src/foo.ts']);
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(
      'export const x = 1;\n',
    );
    expect(registry.size()).toBe(0);

    registry.dispose();
  });

  it('session_get_closeout_proof_bundle returns proof shape without advancing state', async () => {
    const fs = createMemFsAdapter();
    const { client, registry } = await buildClient(PASS_AUDIT, fs);

    const start = parseData<{ session: { sessionId: string } }>(
      await client.callTool({ name: 'start_edit_session', arguments: { manifest: MANIFEST } }),
    );
    const sessionId = start.session.sessionId;
    await client.callTool({ name: 'session_preflight', arguments: { sessionId } });
    await client.callTool({ name: 'session_create_snapshot', arguments: { sessionId } });
    await client.callTool({
      name: 'session_apply_edits',
      arguments: {
        sessionId,
        proposedChanges: [{ file: 'src/foo.ts', content: 'export const ok = 1;\n' }],
      },
    });
    await client.callTool({ name: 'session_audit', arguments: { sessionId } });

    const bundle = parseData<{
      state: SessionState;
      data: {
        closeoutProofBundle: {
          closeoutProofBundleSchemaVersion: number;
          sessionId: string;
          state: string;
          proofVerbosity: string;
          changedFiles: string[];
          historyLength: number;
          proofRefs: { snapshotRef: string | null; auditRef: string | null };
          results: { preflightStatus: string | null; auditStatus: string | null };
        };
      };
    }>(
      await client.callTool({
        name: 'session_get_closeout_proof_bundle',
        arguments: { sessionId, proofVerbosity: 'compact' },
      }),
    );

    expect(bundle.state).toBe('audited_pass');
    expect(bundle.data.closeoutProofBundle).toMatchObject({
      closeoutProofBundleSchemaVersion: 1,
      sessionId,
      state: 'audited_pass',
      proofVerbosity: 'compact',
      changedFiles: ['src/foo.ts'],
      results: { preflightStatus: 'PASS', auditStatus: 'PASS' },
    });
    expect(bundle.data.closeoutProofBundle.historyLength).toBeGreaterThan(0);
    expect(bundle.data.closeoutProofBundle.proofRefs.snapshotRef).toMatch(/^sha256:/);

    registry.dispose();
  });

  it('session_get_closeout_proof_bundle rejects missing and unknown session handles', async () => {
    const { client, registry } = await buildClient();

    const missing = (await client.callTool({
      name: 'session_get_closeout_proof_bundle',
      arguments: {},
    })) as ToolResponse;
    expect(missing.isError).toBe(true);
    const missingBody = JSON.parse(missing.content[0].text) as {
      kind: string;
      guidance?: string;
    };
    expect(missingBody.kind).toBe('invalid_request');
    expect(missingBody.guidance).toContain('sessionId');

    const unknown = (await client.callTool({
      name: 'session_get_closeout_proof_bundle',
      arguments: { sessionId: 'ghost-session' },
    })) as ToolResponse;
    expect(unknown.isError).toBe(true);
    const unknownBody = JSON.parse(unknown.content[0].text) as {
      kind: string;
      sessionId?: string;
    };
    expect(unknownBody.kind).toBe('session_not_found');
    expect(unknownBody.sessionId).toBe('ghost-session');

    registry.dispose();
  });

  it('session_inspect returns the full SessionSnapshot without advancing state', async () => {
    const { client, registry } = await buildClient();

    const start = parseData<{ session: { sessionId: string }; state: SessionState }>(
      await client.callTool({ name: 'start_edit_session', arguments: { manifest: MANIFEST } }),
    );
    const sessionId = start.session.sessionId;

    await client.callTool({ name: 'session_preflight', arguments: { sessionId } });

    const inspect = parseData<{
      state: SessionState;
      snapshot: { history: Array<{ op: string }>; manifest: { projectId: string } };
    }>(await client.callTool({ name: 'session_inspect', arguments: { sessionId } }));
    expect(inspect.state).toBe('preflighted_pass');
    expect(inspect.snapshot.manifest.projectId).toBe(MANIFEST.projectId);
    expect(inspect.snapshot.history.map((h) => h.op)).toEqual(['created', 'preflight']);

    registry.dispose();
  });
});
