import type { HoplonAdapters, HoplonEngine, HoplonEngineConfig } from '../engine/types.js';

export interface HoplonEnginePool {
  acquire(projectId: string, signal?: AbortSignal): Promise<HoplonEngine>;
  release(projectId: string): void;
  stats(): HoplonEnginePoolStats;
  shutdown(opts?: { drainTimeoutMs?: number }): Promise<void>;
}

export interface HoplonEnginePoolStats {
  maxConcurrent: number;
  currentSize: number;
  busyCount: number;
  idleCount: number;
  totalAcquired: number;
  totalEvicted: number;
  projectIds: string[];
}

export interface HoplonEnginePoolOptions {
  maxConcurrent: number;
  adapters: HoplonAdapters;
  config?: HoplonEngineConfig;
  /** Timeout waiting for a free slot. Default: 30 seconds. */
  acquireTimeoutMs?: number;
  /** Prefix for generated engine IDs. Default: pool. */
  engineIdPrefix?: string;
}

export interface PoolEntry {
  engine: HoplonEngine;
  projectId: string;
  refCount: number;
  lastReleaseAt: number;
}

export interface Waiter {
  projectId: string;
  resolve: (engine: HoplonEngine) => void;
  reject: (error: unknown) => void;
  cleanup: () => void;
}
