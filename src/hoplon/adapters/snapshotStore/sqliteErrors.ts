import { AdapterError } from '../../contracts/errors.js';

export function throwSqliteSnapshotRead(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_read_failed',
    engineId: 'adapter',
    correlationId: 'adapter',
    cause,
  }, message);
}

export function throwSqliteSnapshotWrite(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_write_failed',
    engineId: 'adapter',
    correlationId: 'adapter',
    cause,
  }, message);
}
