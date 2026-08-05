/** Public engine-pool facade. Runtime mechanics live beside their shared types. */

export { createHoplonEnginePool } from './enginePoolRuntime.js';
export type {
  HoplonEnginePool,
  HoplonEnginePoolOptions,
  HoplonEnginePoolStats,
} from './enginePoolTypes.js';
