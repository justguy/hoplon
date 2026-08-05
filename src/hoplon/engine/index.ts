/**
 * engine/index.ts — barrel re-export of engine types and factory.
 */

export { createHoplonEngine, createDefaultHoplonEngine } from './factory.js';
export type { SemanticRuntimeAdapters } from './factory.js';
export type { HoplonEngine, HoplonAdapters, HoplonEngineConfig } from './types.js';
export type { ReconcileDeps } from '../operations/reconcile.js';
export type { HealthDeps } from '../operations/health.js';
