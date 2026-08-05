import { SQLITE_ERROR } from './constants.js';
import { result, unavailable } from './results.js';
import {
  createFtsQuery,
  metadataFor,
  objectRow,
  positiveIntegerSql,
  rollback,
  stringField,
} from './sql.js';
import type {
  NativeLexicalIndexAdapter,
  NativeLexicalIndexDocument,
  NativeSemanticMatch,
  NodeSqliteDatabase,
} from './types.js';

export function createLexicalIndex(database: NodeSqliteDatabase): NativeLexicalIndexAdapter {
  return {
    async upsert(projectId, documents) {
      try {
        database.exec('BEGIN IMMEDIATE');
        for (const document of documents) {
          upsertLexicalDocument(database, projectId, document);
        }
        database.exec('COMMIT');
        return result(documents.length === 0 ? 'EMPTY' : 'AVAILABLE', documents.length, []);
      } catch {
        rollback(database);
        return unavailable(SQLITE_ERROR);
      }
    },
    async search(projectId, query, topK) {
      try {
        if (topK <= 0) return result('EMPTY', 0, []);
        const ftsQuery = createFtsQuery(query);
        if (ftsQuery === null) return result('EMPTY', 0, []);
        const rows = database
          .prepare(`SELECT document_id, bm25(semantic_fts) AS score FROM semantic_fts WHERE semantic_fts MATCH ? AND project_id = ? ORDER BY score LIMIT ${positiveIntegerSql(topK)}`)
          .all(ftsQuery, projectId);
        const matches = rows.map((row) => lexicalMatch(database, projectId, row));
        return result(matches.length === 0 ? 'EMPTY' : 'AVAILABLE', matches.length, matches);
      } catch {
        return unavailable(SQLITE_ERROR);
      }
    },
    async delete(projectId, documentIds) {
      try {
        database.exec('BEGIN IMMEDIATE');
        let deleted = 0;
        const deleteDoc = database.prepare('DELETE FROM semantic_documents WHERE project_id = ? AND document_id = ?');
        const deleteFts = database.prepare('DELETE FROM semantic_fts WHERE project_id = ? AND document_id = ?');
        for (const id of documentIds) {
          deleteDoc.run(projectId, id);
          deleteFts.run(projectId, id);
          deleted += 1;
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

function upsertLexicalDocument(
  database: NodeSqliteDatabase,
  projectId: string,
  document: NativeLexicalIndexDocument,
): void {
  database
    .prepare('INSERT INTO semantic_documents(project_id, document_id, text, metadata_json, updated_at_iso) VALUES (?, ?, ?, ?, ?) ON CONFLICT(project_id, document_id) DO UPDATE SET text = excluded.text, metadata_json = excluded.metadata_json, updated_at_iso = excluded.updated_at_iso')
    .run(projectId, document.id, document.text, JSON.stringify(document.metadata), new Date(0).toISOString());
  database
    .prepare('DELETE FROM semantic_fts WHERE project_id = ? AND document_id = ?')
    .run(projectId, document.id);
  database
    .prepare('INSERT INTO semantic_fts(project_id, document_id, text) VALUES (?, ?, ?)')
    .run(projectId, document.id, document.text);
}

function lexicalMatch(
  database: NodeSqliteDatabase,
  projectId: string,
  row: unknown,
): NativeSemanticMatch {
  const object = objectRow(row);
  const documentId = stringField(object, 'document_id');
  const scoreValue = object.score;
  const score = typeof scoreValue === 'number' ? -scoreValue : 0;
  return {
    id: documentId,
    score,
    metadata: metadataFor(database, projectId, documentId, 'semantic_documents', 'document_id'),
  };
}
