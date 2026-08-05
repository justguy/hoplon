/**
 * Local module shim for pg@8.13.3.
 *
 * The pg package does not ship its own TypeScript declarations and @types/pg is
 * not installed. This shim exposes the minimal surface used by PG1
 * (adapters/snapshotStore/postgres.ts).
 *
 * Only Pool, PoolClient, and QueryResult are declared — no other pg internals
 * are used in this codebase.
 */

declare module 'pg' {
  export interface QueryResult<R = Record<string, unknown>> {
    rows: R[];
    rowCount: number | null;
    command: string;
    fields: Array<{ name: string; tableID: number; columnID: number; dataTypeID: number }>;
  }

  export interface PoolConfig {
    host?: string;
    port?: number;
    database?: string;
    user?: string;
    password?: string;
    max?: number;
    idleTimeoutMillis?: number;
    connectionTimeoutMillis?: number;
    ssl?: boolean | Record<string, unknown>;
  }

  export interface PoolClient {
    query<R = Record<string, unknown>>(
      sql: string,
      params?: Array<string | number | boolean | null | undefined>,
    ): Promise<QueryResult<R>>;
    release(err?: Error | boolean): void;
  }

  export class Pool {
    constructor(config?: PoolConfig);
    connect(): Promise<PoolClient>;
    end(): Promise<void>;
    query<R = Record<string, unknown>>(
      sql: string,
      params?: Array<string | number | boolean | null | undefined>,
    ): Promise<QueryResult<R>>;
  }

  export class Client {
    constructor(config?: PoolConfig);
    connect(): Promise<void>;
    end(): Promise<void>;
    query<R = Record<string, unknown>>(
      sql: string,
      params?: Array<string | number | boolean | null | undefined>,
    ): Promise<QueryResult<R>>;
  }

  const pg: {
    Pool: typeof Pool;
    Client: typeof Client;
  };
  export default pg;
}
