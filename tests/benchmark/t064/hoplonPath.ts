/**
 * tests/benchmark/t064/hoplonPath.ts — "hoplon" path primitives.
 *
 * Wraps `runQuery({ command: { kind: 'see', ... } })` for reads/searches
 * and `createHoplonEditSession` for supervised writes. The session
 * constructor is the in-process API the adopted host is meant to use;
 * this mirrors the T-063 proof pattern rather than going over the MCP
 * or HTTP transport so the benchmark measures engine semantics, not
 * transport wiring.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import { runQuery } from '../../../src/hoplon/launcher/query.js';
import { resolveLauncherWorkspace, ensureWorkspaceLayout } from '../../../src/hoplon/launcher/config.js';
import { createDefaultHoplonEngine } from '../../../src/hoplon/engine/factory.js';
import { createHoplonEditSession } from '../../../src/hoplon/session/session.js';
import { createNodeFsAdapter } from '../../../src/hoplon/adapters/fs/node.js';
import type { HoplonEngine } from '../../../src/hoplon/engine/types.js';
import type { WritableManifest } from '../../../src/hoplon/contracts/manifest.js';
import type {
  SeeCodebaseEnvelope,
  SeeCodebaseResult,
  SeeCodebaseTarget,
  SeeCodebaseIntent,
  SeeCodebaseMode,
} from '../../../src/hoplon/contracts/seeCodebase.js';

export interface HoplonPathMeter {
  turns: number;
  bytesRead: number;
  bytesWritten: number;
  fallbackUsed: boolean;
  notes: string[];
}

export function createHoplonMeter(): HoplonPathMeter {
  return { turns: 0, bytesRead: 0, bytesWritten: 0, fallbackUsed: false, notes: [] };
}

export interface HoplonWorkspace {
  root: string;
  grammarsDir: string;
  engineId: string;
}

export async function runSeeCodebase(
  meter: HoplonPathMeter,
  workspace: HoplonWorkspace,
  intent: SeeCodebaseIntent,
  targets: readonly SeeCodebaseTarget[],
  mode?: SeeCodebaseMode,
): Promise<SeeCodebaseEnvelope> {
  meter.turns += 1;
  const envelope = await runQuery<unknown>({
    workspace: {
      root: workspace.root,
      grammarsDir: workspace.grammarsDir,
      engineId: workspace.engineId,
    },
    command: {
      kind: 'see',
      intent,
      targets: [...targets],
      ...(mode !== undefined ? { mode } : {}),
      includeProvenance: true,
    },
  });
  const data = (envelope.data ?? undefined) as SeeCodebaseEnvelope | undefined;
  if (data === undefined) {
    meter.notes.push('runQuery envelope data missing');
    return { ok: false, error: { kind: 'INTERNAL', message: 'envelope data missing', requestedPath: 'raw' } };
  }
  const bytes = estimateSeeCodebaseBytes(data);
  meter.bytesRead += bytes;
  return data;
}

function estimateSeeCodebaseBytes(env: SeeCodebaseEnvelope): number {
  if (!env.ok) return 0;
  let total = 0;
  for (const r of env.data.results) {
    total += estimateResultBytes(r);
  }
  return total;
}

function estimateResultBytes(r: SeeCodebaseResult): number {
  if (r.kind === 'raw_file') return r.bytes;
  if (r.kind === 'raw_search') {
    return r.matches.reduce((s, m) => s + Buffer.byteLength(m.text, 'utf8'), 0);
  }
  // Structural + skeleton payloads: approximate via JSON length so the
  // deterministic harness has a byte cost even though the primitive
  // returns a structured object rather than raw bytes. This matches
  // what seeCodebaseEnvelope's provenance does for bytesReturned.
  try {
    return Buffer.byteLength(JSON.stringify(r.payload ?? {}), 'utf8');
  } catch {
    return 0;
  }
}

export interface HoplonSessionBundle {
  engine: HoplonEngine;
  adapter: ReturnType<typeof createNodeFsAdapter>;
  grammarsDir: string;
}

export async function buildEngineForWorkspace(
  workspaceRoot: string,
  grammarsDir: string,
  engineId: string,
): Promise<HoplonSessionBundle> {
  const workspace = resolveLauncherWorkspace({
    root: workspaceRoot,
    grammarsDir,
    engineId,
  });
  ensureWorkspaceLayout(workspace);
  const engine = await createDefaultHoplonEngine({
    root: workspace.root,
    dbPath: workspace.dbPath,
    gitRepoDir: workspace.gitRepoDir,
    grammarsDir: workspace.grammarsDir,
    engineId: workspace.engineId,
  });
  const adapter = createNodeFsAdapter({ root: workspace.root });
  return { engine, adapter, grammarsDir: workspace.grammarsDir };
}

export interface SupervisedEditInput {
  manifest: WritableManifest;
  proposedChanges: readonly { file: string; content: string }[];
  /** Override the default retry behavior for T6. */
  onBlock?: 'revert' | 'none';
}

export interface SupervisedEditOutcome {
  auditStatus: 'PASS' | 'BLOCK';
  bytesWritten: number;
  revertOccurred: boolean;
  rollbackTemplateFiles: number;
  violationKinds: string[];
}

export async function runSupervisedEdit(
  meter: HoplonPathMeter,
  bundle: HoplonSessionBundle,
  input: SupervisedEditInput,
): Promise<SupervisedEditOutcome> {
  const session = createHoplonEditSession({
    engine: bundle.engine,
    manifest: input.manifest,
    fs: bundle.adapter,
  });

  meter.turns += 1;
  await session.preflight();
  meter.turns += 1;
  await session.createSnapshot();
  meter.turns += 1;
  const applied = await session.applyEdits([...input.proposedChanges]);
  meter.bytesWritten += applied.bytesWritten;
  meter.turns += 1;
  const audit = await session.audit();

  if (audit.status === 'PASS') {
    session.close();
    return {
      auditStatus: 'PASS',
      bytesWritten: applied.bytesWritten,
      revertOccurred: false,
      rollbackTemplateFiles: 0,
      violationKinds: [],
    };
  }

  const violationKinds = audit.status === 'BLOCK' ? audit.violations.map((v) => v.kind) : [];
  if (input.onBlock === 'none') {
    session.close();
    return {
      auditStatus: 'BLOCK',
      bytesWritten: applied.bytesWritten,
      revertOccurred: false,
      rollbackTemplateFiles: 0,
      violationKinds,
    };
  }
  meter.turns += 1;
  await session.revert();
  meter.turns += 1;
  const template = await session.extractRollbackTemplate();
  session.close();
  return {
    auditStatus: 'BLOCK',
    bytesWritten: applied.bytesWritten,
    revertOccurred: true,
    rollbackTemplateFiles: template.files.length,
    violationKinds,
  };
}

export function sessionManifest(args: {
  projectId: string;
  correlationId: string;
  filePath: string;
  symbols: readonly string[];
}): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId: args.projectId,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: args.correlationId,
    entries: [
      {
        path: args.filePath,
        scope: { kind: 'symbols', symbols: [...args.symbols] },
      },
    ],
  };
}

export function readFileOnDisk(workspaceRoot: string, relPath: string): string {
  return fs.readFileSync(path.resolve(workspaceRoot, relPath), 'utf8');
}
