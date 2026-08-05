/**
 * Local module shim for redlock@5.0.0-beta.2.
 *
 * The package ships types at dist/index.d.ts but its package.json `exports`
 * map blocks TypeScript's NodeNext moduleResolution from finding them. Until
 * redlock@5 leaves beta and ships a conforming exports map, this shim
 * exposes the surface we use in RL1.
 */

declare module 'redlock' {
  export interface LockOptions {
    driftFactor?: number;
    retryCount?: number;
    retryDelay?: number;
    retryJitter?: number;
    automaticExtensionThreshold?: number;
  }

  export class Lock {
    release(): Promise<{ attempts: Array<unknown> }>;
    extend(duration: number): Promise<Lock>;
    readonly value: string;
    readonly resources: string[];
    readonly expiration: number;
  }

  export class ExecutionError extends Error {
    readonly message: string;
  }

  export class ResourceLockedError extends Error {}

  export default class Redlock {
    constructor(clients: Array<unknown>, options?: LockOptions);
    acquire(resources: string[], duration: number, settings?: LockOptions): Promise<Lock>;
    quit(): Promise<unknown>;
    using<T>(
      resources: string[],
      duration: number,
      routine: (signal: AbortSignal) => Promise<T>,
    ): Promise<T>;
  }
}
