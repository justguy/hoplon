/**
 * tests/benchmark/t064/types.ts — shared result row shape for the
 * deterministic paired harness. Kept separate so the harness, the
 * corpus modules, and the report writer share one type definition.
 */

export type BenchPath = 'direct' | 'hoplon';

export type AuditStatus = 'PASS' | 'BLOCK' | 'n/a';

export interface BenchResultRow {
  taskId: string;
  path: BenchPath;
  runIndex: number;
  completion: boolean;
  toolTurns: number;
  latencyMs: number;
  bytesRead: number;
  bytesWritten: number;
  fallbackUsed: boolean;
  auditStatus: AuditStatus;
  uncontractedDrift: boolean;
  revertOccurred: boolean;
  retryCount: number;
  notes: string;
}

export interface BenchTaskCategory {
  read?: boolean;
  write?: boolean;
}

export interface BenchRunContext {
  repoRoot: string;
  grammarsDir: string;
  runIndex: number;
  taskId: string;
}

export interface PairedSolver {
  solveDirect(ctx: BenchRunContext, workspaceRoot: string): Promise<BenchResultRow>;
  solveHoplon(ctx: BenchRunContext, workspaceRoot: string): Promise<BenchResultRow>;
}

export interface BenchTask extends PairedSolver {
  id: string;
  name: string;
  category: BenchTaskCategory;
  /** Seed the temp workspace from real repo files before the solver runs. */
  seedWorkspace(ctx: BenchRunContext, workspaceRoot: string): Promise<void>;
  /** Keep the live-pass flag in one place so the design doc and the runner do not drift. */
  includeInLivePass: boolean;
}
