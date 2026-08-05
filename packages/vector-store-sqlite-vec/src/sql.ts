import { INVALID_VECTOR, SQLITE_ERROR } from './constants.js';
import type {
  NativeMetadata,
  NodeSqliteDatabase,
} from './types.js';

export function createFtsQuery(query: string): string | null {
  const tokens = query.toLocaleLowerCase('en-US').match(/[a-z0-9_]+/gu) ?? [];
  if (tokens.length === 0) return null;
  return tokens.map((token) => `"${token.replaceAll('"', '""')}"`).join(' OR ');
}

export function vectorSqlArray(vector: readonly number[], dimension: number): string {
  if (vector.length !== dimension || vector.some((value) => !Number.isFinite(value))) {
    throw new Error(INVALID_VECTOR);
  }
  return `json_array(${vector.map((value) => Number(value).toPrecision(17)).join(',')})`;
}

export function positiveIntegerSql(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(INVALID_VECTOR);
  return String(value);
}

export function safeRowidSql(value: number): string {
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(SQLITE_ERROR);
  return String(value);
}

export function sqlString(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function rollback(database: NodeSqliteDatabase): void {
  try {
    database.exec('ROLLBACK');
  } catch {}
}

export function readString(row: unknown): string | undefined {
  const values = Object.values(objectRow(row));
  return typeof values[0] === 'string' ? values[0] : undefined;
}

export function readVersion(row: unknown): string | undefined {
  const value = objectRow(row).value;
  return typeof value === 'string' ? value : undefined;
}

export function readNumber(row: unknown): number | undefined {
  const values = Object.values(objectRow(row));
  return typeof values[0] === 'number' ? values[0] : undefined;
}

export function readRequiredNumber(row: unknown): number {
  const value = readNumber(row);
  if (value === undefined) throw new Error(SQLITE_ERROR);
  return value;
}

export function objectRow(row: unknown): Record<string, unknown> {
  if (row !== null && typeof row === 'object') return row as Record<string, unknown>;
  throw new Error(SQLITE_ERROR);
}

export function stringField(row: Record<string, unknown>, field: string): string {
  const value = row[field];
  if (typeof value !== 'string') throw new Error(SQLITE_ERROR);
  return value;
}

export function numberField(row: Record<string, unknown>, field: string): number {
  const value = row[field];
  if (typeof value !== 'number') throw new Error(SQLITE_ERROR);
  return value;
}

export function metadataFor(
  database: NodeSqliteDatabase,
  projectId: string,
  id: string | number,
  table: 'semantic_documents' | 'semantic_vector_rows',
  idColumn: 'document_id' | 'rowid',
): NativeMetadata {
  const row = objectRow(
    database
      .prepare(`SELECT metadata_json FROM ${table} WHERE project_id = ? AND ${idColumn} = ?`)
      .get(projectId, id),
  );
  return JSON.parse(stringField(row, 'metadata_json')) as NativeMetadata;
}
