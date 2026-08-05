import { AdapterError } from '../../contracts/errors.js';

export function throwPostgresSnapshotRead(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_read_failed', engineId: 'adapter', correlationId: 'adapter', cause,
  }, message);
}

export function throwPostgresSnapshotWrite(cause: unknown, message: string): never {
  if (cause instanceof AdapterError) throw cause;
  throw new AdapterError({
    kind: 'snapshot_store_write_failed', engineId: 'adapter', correlationId: 'adapter', cause,
  }, message);
}

export function postgresSnapshotErrorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
