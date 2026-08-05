import type { BehaviorTestRunnerAdapter } from '../adapters/behaviorTestRunner.js';
import type { VerifyBehaviorOptions } from '../contracts/verifyBehavior.js';
import type { HoplonEngine } from '../engine/types.js';

export interface ComposeVerifyBehaviorInput {
  readonly engine: HoplonEngine | null;
  readonly runner: BehaviorTestRunnerAdapter | null;
  readonly options: VerifyBehaviorOptions;
  readonly projectId: string;
  readonly runId: string;
  readonly correlationId: string;
  readonly projectRoot: string;
  readonly sessionId: string | null;
  readonly snapshotRefId: string | null;
  readonly changedFiles: readonly string[];
  readonly attemptNumber: number | null;
  readonly now: () => number;
  readonly signal?: AbortSignal | undefined;
}
