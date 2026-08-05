import {
  EXTENSION_UNAVAILABLE,
  SQLITE_ERROR,
} from './constants.js';
import {
  createUnavailableVectorIndex,
  result,
  unavailable,
} from './results.js';
import {
  metadataFor,
  numberField,
  objectRow,
  positiveIntegerSql,
  readNumber,
  readRequiredNumber,
  rollback,
  safeRowidSql,
  sqlString,
  stringField,
  vectorSqlArray,
} from './sql.js';
import type {
  NativeSemanticMatch,
  NativeVectorIndexAdapter,
  NativeVectorIndexRecord,
  NodeSqliteDatabase,
  NodeSqliteVecDescription,
} from './types.js';

export function createVectorIndex(
  database: NodeSqliteDatabase,
  dimension: number,
  description: NodeSqliteVecDescription,
): NativeVectorIndexAdapter {
  if (!description.vectorAvailable) return createUnavailableVectorIndex(EXTENSION_UNAVAILABLE);
  return {
    async upsert(projectId, records) {
      try {
        database.exec('BEGIN IMMEDIATE');
        for (const record of records) upsertVectorRecord(database, projectId, record, dimension);
        database.exec('COMMIT');
        return result(records.length === 0 ? 'EMPTY' : 'AVAILABLE', records.length, []);
      } catch {
        rollback(database);
        return unavailable(SQLITE_ERROR);
      }
    },
    async search(projectId, query, topK) {
      try {
        if (topK <= 0) return result('EMPTY', 0, []);
        const vectorSql = vectorSqlArray(query, dimension);
        const rows = database
          .prepare(`SELECT rowid, distance FROM semantic_vectors WHERE embedding MATCH ${vectorSql} AND project_id = ? AND k = ${positiveIntegerSql(topK)} ORDER BY distance`)
          .all(projectId);
        const matches = rows.map((row) => vectorMatch(database, projectId, row));
        return result(matches.length === 0 ? 'EMPTY' : 'AVAILABLE', matches.length, matches);
      } catch {
        return unavailable(SQLITE_ERROR);
      }
    },
    async delete(projectId, recordIds) {
      try {
        database.exec('BEGIN IMMEDIATE');
        let deleted = 0;
        for (const id of recordIds) {
          const row = database
            .prepare('SELECT rowid FROM semantic_vector_rows WHERE project_id = ? AND document_id = ?')
            .get(projectId, id);
          const rowid = readNumber(row);
          if (rowid !== undefined) {
            database.exec(`DELETE FROM semantic_vectors WHERE rowid = ${safeRowidSql(rowid)}`);
            database.prepare('DELETE FROM semantic_vector_rows WHERE rowid = ?').run(rowid);
            deleted += 1;
          }
        }
        database.exec('COMMIT');
        return result(deleted === 0 ? 'EMPTY' : 'AVAILABLE', deleted, []);
      } catch {
        rollback(database);
        return unavailable(SQLITE_ERROR);
      }
    },
  };
}

function upsertVectorRecord(
  database: NodeSqliteDatabase,
  projectId: string,
  record: NativeVectorIndexRecord,
  dimension: number,
): void {
  database
    .prepare('INSERT INTO semantic_vector_rows(project_id, document_id, metadata_json, updated_at_iso) VALUES (?, ?, ?, ?) ON CONFLICT(project_id, document_id) DO UPDATE SET metadata_json = excluded.metadata_json, updated_at_iso = excluded.updated_at_iso')
    .run(projectId, record.id, JSON.stringify(record.metadata), new Date(0).toISOString());
  const rowid = readRequiredNumber(
    database
      .prepare('SELECT rowid FROM semantic_vector_rows WHERE project_id = ? AND document_id = ?')
      .get(projectId, record.id),
  );
  database.exec(`DELETE FROM semantic_vectors WHERE rowid = ${safeRowidSql(rowid)}`);
  database.exec(`INSERT INTO semantic_vectors(rowid, project_id, embedding) VALUES (${safeRowidSql(rowid)}, ${sqlString(projectId)}, ${vectorSqlArray(record.vector, dimension)})`);
}

function vectorMatch(
  database: NodeSqliteDatabase,
  projectId: string,
  row: unknown,
): NativeSemanticMatch {
  const object = objectRow(row);
  const rowid = numberField(object, 'rowid');
  const distance = numberField(object, 'distance');
  const document = objectRow(
    database
      .prepare('SELECT document_id FROM semantic_vector_rows WHERE project_id = ? AND rowid = ?')
      .get(projectId, rowid),
  );
  return {
    id: stringField(document, 'document_id'),
    score: 1 / (1 + distance),
    metadata: metadataFor(database, projectId, rowid, 'semantic_vector_rows', 'rowid'),
  };
}
