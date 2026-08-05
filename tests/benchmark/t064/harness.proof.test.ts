/**
 * tests/benchmark/t064/harness.proof.test.ts — deterministic T-064 harness.
 *
 * Iterates the fixed CORPUS, runs each task on a fresh temp workspace twice
 * per path (direct + hoplon), and writes the full result matrix to a temp
 * file. Per-task sanity assertions enforce the T-064 benchmark invariants
 * (T5 must
 * BLOCK+revert on the Hoplon path, T4 must PASS, etc.) so drift in the
 * underlying engines surfaces as test failures rather than silent
 * regressions in the recommendation.
 *
 * The real repo is never mutated — each run seeds a temp workspace from
 * real files via the task's seedWorkspace hook and rm's it in `finally`.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

import { CORPUS } from './corpus.js';
import type { BenchResultRow, BenchRunContext, BenchTask } from './types.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '../../..');
const GRAMMARS_DIR = path.resolve(REPO_ROOT, 'vendor/grammars');
const RESULTS_PATH = path.resolve(os.tmpdir(), 'hoplon-t064-bench-results.json');

const RUNS_PER_PATH = 2;

function makeTempWorkspace(taskId: string, runIndex: number, pathLabel: string): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), `hoplon-t064-${taskId}-${pathLabel}-${runIndex}-`));
}

async function runOnce(
  task: BenchTask,
  ctx: BenchRunContext,
  pathLabel: 'direct' | 'hoplon',
): Promise<BenchResultRow> {
  const workspaceRoot = makeTempWorkspace(task.id, ctx.runIndex, pathLabel);
  try {
    await task.seedWorkspace(ctx, workspaceRoot);
    return pathLabel === 'direct'
      ? await task.solveDirect(ctx, workspaceRoot)
      : await task.solveHoplon(ctx, workspaceRoot);
  } finally {
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

function assertPerTaskInvariants(task: BenchTask, rows: readonly BenchResultRow[]): void {
  const direct = rows.filter((r) => r.path === 'direct');
  const hoplon = rows.filter((r) => r.path === 'hoplon');
  expect(direct.length).toBe(RUNS_PER_PATH);
  expect(hoplon.length).toBe(RUNS_PER_PATH);

  switch (task.id) {
    case 'T1':
    case 'T2':
    case 'T3':
      for (const r of [...direct, ...hoplon]) {
        expect(r.completion, `${task.id} ${r.path} run ${r.runIndex} must complete: ${r.notes}`).toBe(true);
        expect(r.bytesWritten).toBe(0);
      }
      break;
    case 'T4':
      for (const r of [...direct, ...hoplon]) {
        expect(r.completion, `${task.id} ${r.path} run ${r.runIndex} must complete: ${r.notes}`).toBe(true);
        expect(r.uncontractedDrift).toBe(false);
      }
      for (const r of hoplon) {
        expect(r.auditStatus).toBe('PASS');
      }
      break;
    case 'T5':
      for (const r of direct) {
        // Direct has no contract — the write succeeds *as a write* but the
        // task definition says success requires no out-of-scope drift. So
        // completion is false and drift is true.
        expect(r.completion).toBe(false);
        expect(r.uncontractedDrift).toBe(true);
      }
      for (const r of hoplon) {
        expect(r.auditStatus).toBe('BLOCK');
        expect(r.revertOccurred).toBe(true);
        expect(r.completion).toBe(true);
        expect(r.uncontractedDrift).toBe(false);
      }
      break;
    case 'T6':
      for (const r of hoplon) {
        expect(r.completion, `${task.id} hoplon run ${r.runIndex}: ${r.notes}`).toBe(true);
        expect(r.auditStatus).toBe('PASS');
        expect(r.revertOccurred).toBe(true);
        expect(r.retryCount).toBe(1);
      }
      // Direct path: the first naive attempt lands drift; retry writes the
      // marker over the drifted state. Drift is expected to stay.
      for (const r of direct) {
        expect(r.uncontractedDrift).toBe(true);
      }
      break;
    default:
      throw new Error(`unknown task id: ${task.id}`);
  }
}

describe('T-064 deterministic paired harness', () => {
  it('runs the full corpus twice per path and writes results', async () => {
    const all: BenchResultRow[] = [];

    for (const task of CORPUS) {
      const taskRows: BenchResultRow[] = [];
      for (let runIndex = 0; runIndex < RUNS_PER_PATH; runIndex++) {
        const ctx: BenchRunContext = {
          repoRoot: REPO_ROOT,
          grammarsDir: GRAMMARS_DIR,
          runIndex,
          taskId: task.id,
        };
        taskRows.push(await runOnce(task, ctx, 'direct'));
        taskRows.push(await runOnce(task, ctx, 'hoplon'));
      }
      assertPerTaskInvariants(task, taskRows);
      all.push(...taskRows);
    }

    const summary = summarize(all);
    const payload = {
      version: 1 as const,
      producedAt: new Date().toISOString(),
      runsPerPath: RUNS_PER_PATH,
      corpus: CORPUS.map((t) => ({ id: t.id, name: t.name, category: t.category, includeInLivePass: t.includeInLivePass })),
      summary,
      rows: all,
    };
    fs.mkdirSync(path.dirname(RESULTS_PATH), { recursive: true });
    fs.writeFileSync(RESULTS_PATH, JSON.stringify(payload, null, 2));

    expect(all.length).toBe(CORPUS.length * RUNS_PER_PATH * 2);
  }, 300_000);
});

interface PerTaskSummary {
  taskId: string;
  direct: PathAgg;
  hoplon: PathAgg;
}

interface PathAgg {
  completionRate: number;
  avgToolTurns: number;
  avgLatencyMs: number;
  avgBytesRead: number;
  avgBytesWritten: number;
  driftCount: number;
  revertCount: number;
}

function summarize(rows: readonly BenchResultRow[]): PerTaskSummary[] {
  const byTask = new Map<string, BenchResultRow[]>();
  for (const r of rows) {
    const list = byTask.get(r.taskId) ?? [];
    list.push(r);
    byTask.set(r.taskId, list);
  }
  const out: PerTaskSummary[] = [];
  for (const [taskId, list] of byTask) {
    out.push({
      taskId,
      direct: aggregate(list.filter((r) => r.path === 'direct')),
      hoplon: aggregate(list.filter((r) => r.path === 'hoplon')),
    });
  }
  out.sort((a, b) => a.taskId.localeCompare(b.taskId));
  return out;
}

function aggregate(rows: readonly BenchResultRow[]): PathAgg {
  const n = rows.length || 1;
  const sum = (pick: (r: BenchResultRow) => number): number => rows.reduce((s, r) => s + pick(r), 0);
  return {
    completionRate: sum((r) => (r.completion ? 1 : 0)) / n,
    avgToolTurns: sum((r) => r.toolTurns) / n,
    avgLatencyMs: sum((r) => r.latencyMs) / n,
    avgBytesRead: sum((r) => r.bytesRead) / n,
    avgBytesWritten: sum((r) => r.bytesWritten) / n,
    driftCount: sum((r) => (r.uncontractedDrift ? 1 : 0)),
    revertCount: sum((r) => (r.revertOccurred ? 1 : 0)),
  };
}
