/**
 * tests/benchmark/t064/corpus.ts — fixed T-064 corpus tasks.
 *
 * Each task is deterministic on the seeded workspace and reports a
 * single `BenchResultRow` per path per run.
 *
 * Solvers are scripted (not LLM-driven). The scripted solvers represent
 * the *best-case* behavior of a perfectly-competent agent on each path,
 * which is the right baseline for measuring engine cost/ceremony. The
 * live-agent pass (handled separately) measures what real LLM-driven
 * agents do.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';

import type { BenchResultRow, BenchTask } from './types.js';
import {
  createDirectMeter,
  directGrep,
  directReadFile,
  directWriteFile,
} from './directPath.js';
import {
  buildEngineForWorkspace,
  createHoplonMeter,
  readFileOnDisk,
  runSeeCodebase,
  runSupervisedEdit,
  sessionManifest,
  type HoplonWorkspace,
} from './hoplonPath.js';

// ---------------------------------------------------------------------------
// Shared seeds
// ---------------------------------------------------------------------------

const SESSION_ERRORS_REL = 'src/hoplon/session/errors.ts';
const HOST_WORKFLOW_REL = 'docs/HOPLON_HOST_WORKFLOW.md';
const TSCONFIG_REL = 'tsconfig.json';

function copySeed(repoRoot: string, workspaceRoot: string, relPath: string): void {
  const src = path.resolve(repoRoot, relPath);
  const dst = path.resolve(workspaceRoot, relPath);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}

function makeDirectRow(
  ctx: { taskId: string; runIndex: number },
  opts: {
    completion: boolean;
    latencyMs: number;
    meter: ReturnType<typeof createDirectMeter>;
    uncontractedDrift?: boolean;
    retryCount?: number;
    auditStatus?: 'PASS' | 'BLOCK' | 'n/a';
    notes?: string;
  },
): BenchResultRow {
  return {
    taskId: ctx.taskId,
    path: 'direct',
    runIndex: ctx.runIndex,
    completion: opts.completion,
    toolTurns: opts.meter.turns,
    latencyMs: opts.latencyMs,
    bytesRead: opts.meter.bytesRead,
    bytesWritten: opts.meter.bytesWritten,
    fallbackUsed: opts.meter.fallbackUsed,
    auditStatus: opts.auditStatus ?? 'n/a',
    uncontractedDrift: opts.uncontractedDrift ?? false,
    revertOccurred: false,
    retryCount: opts.retryCount ?? 0,
    notes: (opts.notes ?? '') + (opts.meter.notes.length > 0 ? ` | ${opts.meter.notes.join('; ')}` : ''),
  };
}

function makeHoplonRow(
  ctx: { taskId: string; runIndex: number },
  opts: {
    completion: boolean;
    latencyMs: number;
    meter: ReturnType<typeof createHoplonMeter>;
    auditStatus?: 'PASS' | 'BLOCK' | 'n/a';
    uncontractedDrift?: boolean;
    revertOccurred?: boolean;
    retryCount?: number;
    notes?: string;
  },
): BenchResultRow {
  return {
    taskId: ctx.taskId,
    path: 'hoplon',
    runIndex: ctx.runIndex,
    completion: opts.completion,
    toolTurns: opts.meter.turns,
    latencyMs: opts.latencyMs,
    bytesRead: opts.meter.bytesRead,
    bytesWritten: opts.meter.bytesWritten,
    fallbackUsed: opts.meter.fallbackUsed,
    auditStatus: opts.auditStatus ?? 'n/a',
    uncontractedDrift: opts.uncontractedDrift ?? false,
    revertOccurred: opts.revertOccurred ?? false,
    retryCount: opts.retryCount ?? 0,
    notes: (opts.notes ?? '') + (opts.meter.notes.length > 0 ? ` | ${opts.meter.notes.join('; ')}` : ''),
  };
}

function hoplonWorkspaceFor(workspaceRoot: string, ctx: { taskId: string; runIndex: number }, grammarsDir: string): HoplonWorkspace {
  return {
    root: workspaceRoot,
    grammarsDir,
    engineId: `t064-${ctx.taskId}-${ctx.runIndex}`,
  };
}

// ---------------------------------------------------------------------------
// T1 — locate_symbol (read)
// ---------------------------------------------------------------------------

const T1: BenchTask = {
  id: 'T1',
  name: 'locate_symbol',
  category: { read: true },
  includeInLivePass: true,
  async seedWorkspace(ctx, workspaceRoot) {
    copySeed(ctx.repoRoot, workspaceRoot, SESSION_ERRORS_REL);
  },
  async solveDirect(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createDirectMeter();
    const matches = directGrep(meter, workspaceRoot, '^export class SessionError', '*.ts');
    const locate = matches.find((m) => m.path.endsWith(SESSION_ERRORS_REL));
    if (!locate) {
      return makeDirectRow({ taskId: T1.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: 'grep found no matching declaration',
      });
    }
    // Find the closing brace by scanning the file.
    const content = directReadFile(meter, workspaceRoot, SESSION_ERRORS_REL);
    const lines = content.split('\n');
    let depth = 0;
    let startLine = locate.line;
    let endLine = -1;
    for (let i = startLine - 1; i < lines.length; i++) {
      for (const ch of lines[i] ?? '') {
        if (ch === '{') depth += 1;
        else if (ch === '}') {
          depth -= 1;
          if (depth === 0) {
            endLine = i + 1;
            break;
          }
        }
      }
      if (endLine !== -1) break;
    }
    const completion = endLine > startLine;
    return makeDirectRow({ taskId: T1.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      notes: completion ? `range=${startLine},${endLine}` : 'failed to close brace',
    });
  },
  async solveHoplon(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createHoplonMeter();
    const workspace = hoplonWorkspaceFor(workspaceRoot, { taskId: T1.id, runIndex: ctx.runIndex }, ctx.grammarsDir);
    const env = await runSeeCodebase(
      meter,
      workspace,
      'find_symbol',
      [{ kind: 'symbol', name: 'SessionError', file: SESSION_ERRORS_REL }],
    );
    if (!env.ok) {
      return makeHoplonRow({ taskId: T1.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: `envelope error: ${env.error.kind}`,
      });
    }
    const structural = env.data.results.find((r) => r.kind === 'structural');
    const completion = structural !== undefined;
    return makeHoplonRow({ taskId: T1.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      notes: completion ? `primitivesUsed=${(env.provenance?.primitivesUsed ?? []).join(',')}` : 'no structural result',
    });
  },
};

// ---------------------------------------------------------------------------
// T2 — read_docs_section (read — raw-text companion territory)
// ---------------------------------------------------------------------------

const T2_HEADING_CANDIDATES = [
  '## Ordered Supervised-Edit Loop',
  '## Supervised Edit Loop',
  '## Ordered Loop',
  '## Workflow',
];

function extractMarkdownSection(content: string, heading: string): string | null {
  const lines = content.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i] === heading || lines[i]?.startsWith(heading)) {
      startIdx = i;
      break;
    }
  }
  if (startIdx < 0) return null;
  let endIdx = lines.length;
  for (let i = startIdx + 1; i < lines.length; i++) {
    const line = lines[i] ?? '';
    if (line.startsWith('## ') && !line.startsWith('### ')) {
      endIdx = i;
      break;
    }
  }
  return lines.slice(startIdx, endIdx).join('\n');
}

function pickHeading(content: string): string | null {
  for (const h of T2_HEADING_CANDIDATES) {
    if (extractMarkdownSection(content, h) !== null) return h;
  }
  // Fall back: pick the first `## ` heading.
  for (const line of content.split('\n')) {
    if (line.startsWith('## ') && !line.startsWith('### ')) return line;
  }
  return null;
}

const T2: BenchTask = {
  id: 'T2',
  name: 'read_docs_section',
  category: { read: true },
  includeInLivePass: false,
  async seedWorkspace(ctx, workspaceRoot) {
    copySeed(ctx.repoRoot, workspaceRoot, HOST_WORKFLOW_REL);
  },
  async solveDirect(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createDirectMeter();
    const content = directReadFile(meter, workspaceRoot, HOST_WORKFLOW_REL);
    const heading = pickHeading(content);
    if (heading === null) {
      return makeDirectRow({ taskId: T2.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: 'no markdown section headings found',
      });
    }
    const section = extractMarkdownSection(content, heading);
    const completion = section !== null && section.length > 0;
    return makeDirectRow({ taskId: T2.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      notes: completion ? `section=${heading.slice(0, 40)} len=${section!.length}` : 'extraction failed',
    });
  },
  async solveHoplon(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createHoplonMeter();
    const workspace = hoplonWorkspaceFor(workspaceRoot, { taskId: T2.id, runIndex: ctx.runIndex }, ctx.grammarsDir);
    const env = await runSeeCodebase(
      meter,
      workspace,
      'inspect_docs_or_config',
      [{ kind: 'file', path: HOST_WORKFLOW_REL }],
    );
    if (!env.ok) {
      return makeHoplonRow({ taskId: T2.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: `envelope error: ${env.error.kind}`,
      });
    }
    const raw = env.data.results.find((r) => r.kind === 'raw_file');
    if (!raw || raw.kind !== 'raw_file') {
      return makeHoplonRow({ taskId: T2.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: 'no raw_file result in envelope',
      });
    }
    const heading = pickHeading(raw.content);
    const section = heading === null ? null : extractMarkdownSection(raw.content, heading);
    const completion = section !== null && section.length > 0;
    return makeHoplonRow({ taskId: T2.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      notes: completion
        ? `path=${env.provenance?.selectedPath} heading=${heading!.slice(0, 40)}`
        : 'section extraction failed',
    });
  },
};

// ---------------------------------------------------------------------------
// T3 — config_lookup (read — JSON config)
// ---------------------------------------------------------------------------

const T3: BenchTask = {
  id: 'T3',
  name: 'config_lookup',
  category: { read: true },
  includeInLivePass: false,
  async seedWorkspace(ctx, workspaceRoot) {
    copySeed(ctx.repoRoot, workspaceRoot, TSCONFIG_REL);
  },
  async solveDirect(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createDirectMeter();
    const content = directReadFile(meter, workspaceRoot, TSCONFIG_REL);
    let strict: unknown = undefined;
    try {
      const parsed = JSON.parse(content) as { compilerOptions?: { strict?: unknown } };
      strict = parsed.compilerOptions?.strict;
    } catch (err) {
      meter.notes.push(`parse failed: ${(err as Error).message.slice(0, 60)}`);
    }
    const completion = strict === true;
    return makeDirectRow({ taskId: T3.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      notes: `strict=${String(strict)}`,
    });
  },
  async solveHoplon(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createHoplonMeter();
    const workspace = hoplonWorkspaceFor(workspaceRoot, { taskId: T3.id, runIndex: ctx.runIndex }, ctx.grammarsDir);
    const env = await runSeeCodebase(
      meter,
      workspace,
      'inspect_docs_or_config',
      [{ kind: 'file', path: TSCONFIG_REL }],
    );
    if (!env.ok) {
      return makeHoplonRow({ taskId: T3.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: `envelope error: ${env.error.kind}`,
      });
    }
    const raw = env.data.results.find((r) => r.kind === 'raw_file');
    if (!raw || raw.kind !== 'raw_file') {
      return makeHoplonRow({ taskId: T3.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: 'no raw_file result',
      });
    }
    let strict: unknown;
    try {
      strict = (JSON.parse(raw.content) as { compilerOptions?: { strict?: unknown } }).compilerOptions?.strict;
    } catch (err) {
      meter.notes.push(`parse failed: ${(err as Error).message.slice(0, 60)}`);
    }
    const completion = strict === true;
    return makeHoplonRow({ taskId: T3.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      notes: `strict=${String(strict)} path=${env.provenance?.selectedPath}`,
    });
  },
};

// ---------------------------------------------------------------------------
// Write-task helpers
// ---------------------------------------------------------------------------

const MARKER = '// t-064 benchmark marker';
const OUT_OF_SCOPE_STMT = "export const T064_OUT_OF_SCOPE = 'drift';";

function applyInScopeEdit(baseline: string): string {
  return baseline.replace(
    'export class SessionError extends Error {',
    `export class SessionError extends Error {\n  ${MARKER}`,
  );
}

function applyOutOfScopeEdit(baseline: string): string {
  const tail = baseline.endsWith('\n') ? '' : '\n';
  return `${baseline}${tail}${OUT_OF_SCOPE_STMT}\n`;
}

function detectUncontractedDrift(baseline: string, onDisk: string, allowedDiff: 'in_scope' | 'out_of_scope' | 'none'): boolean {
  if (onDisk === baseline) return false;
  if (allowedDiff === 'none') return true;
  if (allowedDiff === 'in_scope') {
    // Allowed: the marker inside SessionError body. Any other diff is drift.
    if (!onDisk.includes(MARKER)) return true;
    const withoutMarker = onDisk.replace(`\n  ${MARKER}`, '');
    return withoutMarker !== baseline;
  }
  // allowedDiff === 'out_of_scope': direct T5 intentionally leaks.
  return onDisk !== `${baseline.endsWith('\n') ? baseline : baseline + '\n'}${OUT_OF_SCOPE_STMT}\n`;
}

// ---------------------------------------------------------------------------
// T4 — edit_in_scope_pass
// ---------------------------------------------------------------------------

const T4: BenchTask = {
  id: 'T4',
  name: 'edit_in_scope_pass',
  category: { write: true },
  includeInLivePass: true,
  async seedWorkspace(ctx, workspaceRoot) {
    copySeed(ctx.repoRoot, workspaceRoot, SESSION_ERRORS_REL);
  },
  async solveDirect(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createDirectMeter();
    const baseline = directReadFile(meter, workspaceRoot, SESSION_ERRORS_REL);
    const edited = applyInScopeEdit(baseline);
    if (edited === baseline) {
      return makeDirectRow({ taskId: T4.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        notes: 'marker substitution failed',
      });
    }
    directWriteFile(meter, workspaceRoot, SESSION_ERRORS_REL, edited);
    const onDisk = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const drift = detectUncontractedDrift(baseline, onDisk, 'in_scope');
    return makeDirectRow({ taskId: T4.id, runIndex: ctx.runIndex }, {
      completion: onDisk.includes(MARKER) && !drift,
      latencyMs: Date.now() - started,
      meter,
      uncontractedDrift: drift,
      notes: drift ? 'drift detected' : 'in-scope marker present',
    });
  },
  async solveHoplon(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createHoplonMeter();
    const baseline = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const edited = applyInScopeEdit(baseline);
    const bundle = await buildEngineForWorkspace(workspaceRoot, ctx.grammarsDir, `t064-${T4.id}-${ctx.runIndex}`);
    const outcome = await runSupervisedEdit(meter, bundle, {
      manifest: sessionManifest({
        projectId: `t064-${T4.id}`,
        correlationId: `corr-t064-${T4.id}-${ctx.runIndex}`,
        filePath: SESSION_ERRORS_REL,
        symbols: ['SessionError'],
      }),
      proposedChanges: [{ file: SESSION_ERRORS_REL, content: edited }],
    });
    const onDisk = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const drift = detectUncontractedDrift(baseline, onDisk, 'in_scope');
    return makeHoplonRow({ taskId: T4.id, runIndex: ctx.runIndex }, {
      completion: outcome.auditStatus === 'PASS' && !drift,
      latencyMs: Date.now() - started,
      meter,
      auditStatus: outcome.auditStatus,
      uncontractedDrift: drift,
      revertOccurred: outcome.revertOccurred,
      notes: `audit=${outcome.auditStatus}`,
    });
  },
};

// ---------------------------------------------------------------------------
// T5 — edit_out_of_scope_drift
// ---------------------------------------------------------------------------

const T5: BenchTask = {
  id: 'T5',
  name: 'edit_out_of_scope_drift',
  category: { write: true },
  includeInLivePass: true,
  async seedWorkspace(ctx, workspaceRoot) {
    copySeed(ctx.repoRoot, workspaceRoot, SESSION_ERRORS_REL);
  },
  async solveDirect(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createDirectMeter();
    const baseline = directReadFile(meter, workspaceRoot, SESSION_ERRORS_REL);
    const edited = applyOutOfScopeEdit(baseline);
    directWriteFile(meter, workspaceRoot, SESSION_ERRORS_REL, edited);
    const onDisk = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    // Direct path has no contract; the append is "successful" as a write but
    // counts as drift because the benchmark task is "edit SessionError
    // safely" and the append is out-of-scope.
    const drift = onDisk.includes(OUT_OF_SCOPE_STMT);
    return makeDirectRow({ taskId: T5.id, runIndex: ctx.runIndex }, {
      completion: false,
      latencyMs: Date.now() - started,
      meter,
      uncontractedDrift: drift,
      notes: drift ? 'out-of-scope symbol landed (no gate)' : 'write did not land',
    });
  },
  async solveHoplon(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createHoplonMeter();
    const baseline = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const edited = applyOutOfScopeEdit(baseline);
    const bundle = await buildEngineForWorkspace(workspaceRoot, ctx.grammarsDir, `t064-${T5.id}-${ctx.runIndex}`);
    const outcome = await runSupervisedEdit(meter, bundle, {
      manifest: sessionManifest({
        projectId: `t064-${T5.id}`,
        correlationId: `corr-t064-${T5.id}-${ctx.runIndex}`,
        filePath: SESSION_ERRORS_REL,
        symbols: ['SessionError'],
      }),
      proposedChanges: [{ file: SESSION_ERRORS_REL, content: edited }],
    });
    const onDisk = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const drift = detectUncontractedDrift(baseline, onDisk, 'none');
    const completion = outcome.auditStatus === 'BLOCK' && outcome.revertOccurred && !drift;
    return makeHoplonRow({ taskId: T5.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      auditStatus: outcome.auditStatus,
      uncontractedDrift: drift,
      revertOccurred: outcome.revertOccurred,
      notes: `audit=${outcome.auditStatus} violationKinds=${outcome.violationKinds.join(',')} rollbackFiles=${outcome.rollbackTemplateFiles}`,
    });
  },
};

// ---------------------------------------------------------------------------
// T6 — retry_after_block
// ---------------------------------------------------------------------------

const T6: BenchTask = {
  id: 'T6',
  name: 'retry_after_block',
  category: { write: true },
  includeInLivePass: false,
  async seedWorkspace(ctx, workspaceRoot) {
    copySeed(ctx.repoRoot, workspaceRoot, SESSION_ERRORS_REL);
  },
  async solveDirect(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createDirectMeter();
    const baseline = directReadFile(meter, workspaceRoot, SESSION_ERRORS_REL);
    // First attempt — naive violating edit (no gate to catch it).
    const violating = applyOutOfScopeEdit(baseline);
    directWriteFile(meter, workspaceRoot, SESSION_ERRORS_REL, violating);
    // Second attempt — in-scope marker on top of the violating state.
    const afterFirst = directReadFile(meter, workspaceRoot, SESSION_ERRORS_REL);
    const corrected = applyInScopeEdit(afterFirst);
    directWriteFile(meter, workspaceRoot, SESSION_ERRORS_REL, corrected);
    const onDisk = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const drift = onDisk.includes(OUT_OF_SCOPE_STMT);
    return makeDirectRow({ taskId: T6.id, runIndex: ctx.runIndex }, {
      completion: onDisk.includes(MARKER) && !drift,
      latencyMs: Date.now() - started,
      meter,
      retryCount: 1,
      uncontractedDrift: drift,
      notes: drift
        ? 'retry landed marker but also left out-of-scope from first attempt'
        : 'retry landed marker cleanly',
    });
  },
  async solveHoplon(ctx, workspaceRoot) {
    const started = Date.now();
    const meter = createHoplonMeter();
    const baseline = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const bundle = await buildEngineForWorkspace(workspaceRoot, ctx.grammarsDir, `t064-${T6.id}-${ctx.runIndex}`);
    // First attempt — BLOCK + revert + rollback template.
    const violating = applyOutOfScopeEdit(baseline);
    const first = await runSupervisedEdit(meter, bundle, {
      manifest: sessionManifest({
        projectId: `t064-${T6.id}-a`,
        correlationId: `corr-t064-${T6.id}-a-${ctx.runIndex}`,
        filePath: SESSION_ERRORS_REL,
        symbols: ['SessionError'],
      }),
      proposedChanges: [{ file: SESSION_ERRORS_REL, content: violating }],
    });
    if (first.auditStatus !== 'BLOCK' || !first.revertOccurred) {
      return makeHoplonRow({ taskId: T6.id, runIndex: ctx.runIndex }, {
        completion: false,
        latencyMs: Date.now() - started,
        meter,
        auditStatus: first.auditStatus,
        revertOccurred: first.revertOccurred,
        retryCount: 0,
        notes: 'first attempt did not BLOCK+revert as expected',
      });
    }
    // Second attempt — compliant in-scope marker.
    const restored = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const corrected = applyInScopeEdit(restored);
    const second = await runSupervisedEdit(meter, bundle, {
      manifest: sessionManifest({
        projectId: `t064-${T6.id}-b`,
        correlationId: `corr-t064-${T6.id}-b-${ctx.runIndex}`,
        filePath: SESSION_ERRORS_REL,
        symbols: ['SessionError'],
      }),
      proposedChanges: [{ file: SESSION_ERRORS_REL, content: corrected }],
    });
    const onDisk = readFileOnDisk(workspaceRoot, SESSION_ERRORS_REL);
    const drift = detectUncontractedDrift(baseline, onDisk, 'in_scope');
    const completion = second.auditStatus === 'PASS' && !drift;
    return makeHoplonRow({ taskId: T6.id, runIndex: ctx.runIndex }, {
      completion,
      latencyMs: Date.now() - started,
      meter,
      auditStatus: second.auditStatus,
      uncontractedDrift: drift,
      revertOccurred: first.revertOccurred,
      retryCount: 1,
      notes: `firstBlockKinds=${first.violationKinds.join(',')} rollbackFiles=${first.rollbackTemplateFiles} secondAudit=${second.auditStatus}`,
    });
  },
};

// ---------------------------------------------------------------------------
// Corpus export
// ---------------------------------------------------------------------------

export const CORPUS: readonly BenchTask[] = [T1, T2, T3, T4, T5, T6];
export const LIVE_CORPUS: readonly BenchTask[] = CORPUS.filter((t) => t.includeInLivePass);
