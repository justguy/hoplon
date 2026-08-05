/**
 * tests/util/fineTuningExport.test.ts — Fine-tuning dataset export test suite.
 *
 * Test inventory:
 *   FT-1   Empty audit log → empty iterator (0 yields)
 *   FT-2   5 mixed PASS/BLOCK rows → 5 NDJSON lines, each schema-valid
 *   FT-3   sinceIso filter → only records >= that timestamp
 *   FT-4   projectIds filter → only matching projects
 *   FT-5   format='json' → single JSON array string
 *   FT-6   format='jsonl' (default) → newline-delimited
 *   FT-7   H13: no field carries content beyond counts/kinds/ids; manifest paths NOT in output
 *   FT-8   ERROR result rows are excluded from the export
 *   FT-9   writeFineTuningDatasetToFile: file content readable; recordCount matches
 *   FT-10  untilIso filter → only records <= that timestamp
 *   FT-11  projectIds filter — excludes non-listed projects
 *   FT-12  FineTuningRecordSchema validates each emitted record (Zod parse)
 *
 * All tests use createIsolatedTestStore() — in-memory sql.js, no filesystem I/O.
 * File write tests use createMemFsAdapter() — in-memory fs.
 */

import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';

import { createIsolatedTestStore } from '../../src/hoplon/adapters/snapshot-store-sqlite.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import {
  exportFineTuningDataset,
  writeFineTuningDatasetToFile,
  projectRunQueryFn,
  FineTuningRecordSchema,
} from '../../src/hoplon/util/fineTuningExport.js';
import type { AuditLogRecord } from '../../src/hoplon/contracts/auditLog.js';
import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeAuditRow(overrides: Partial<AuditLogRecord> = {}): AuditLogRecord {
  return {
    id: randomUUID(),
    snapshotId: 'sha256:' + 'a'.repeat(64),
    projectId: 'proj-test',
    runId: 'run-test',
    engineId: 'test-engine',
    correlationId: 'corr-test',
    operation: 'AUDIT_DIFF',
    result: 'PASS',
    violationCount: 0,
    violationKinds: [],
    durationMs: 42,
    createdAt: '2026-04-10T12:00:00.000Z',
    astNodeCount: 100,
    fileLineCount: 50,
    manifestScopeRatio: 0.8,
    ...overrides,
  };
}

async function seedRows(
  store: SnapshotStore,
  rows: AuditLogRecord[],
): Promise<void> {
  for (const row of rows) {
    await store.appendAuditLog(row);
  }
}

/** Collect all yields from the async generator into an array of strings. */
async function collectLines(gen: AsyncIterable<string>): Promise<string[]> {
  const lines: string[] = [];
  for await (const line of gen) {
    lines.push(line);
  }
  return lines;
}

// ---------------------------------------------------------------------------
// FT-1: Empty audit log → empty iterator
// ---------------------------------------------------------------------------

describe('FT-1: empty audit log → empty iterator', () => {
  it('yields no lines when audit log has no entries', async () => {
    const store = await createIsolatedTestStore();
    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-empty', runId: 'run-empty' }]);

    const lines = await collectLines(
      exportFineTuningDataset({ queryFn, projectIds: ['proj-empty'] }),
    );

    expect(lines).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// FT-2: 5 mixed PASS/BLOCK rows → 5 NDJSON lines, each schema-valid
// ---------------------------------------------------------------------------

describe('FT-2: 5 mixed PASS/BLOCK rows → 5 NDJSON lines, each schema-valid', () => {
  it('yields one line per PASS/BLOCK row; each line parses to a valid FineTuningRecord', async () => {
    const store = await createIsolatedTestStore();

    const rows: AuditLogRecord[] = [
      makeAuditRow({ result: 'PASS', operation: 'AUDIT_DIFF', violationKinds: [], violationCount: 0 }),
      makeAuditRow({ result: 'BLOCK', operation: 'AUDIT_DIFF', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
      makeAuditRow({ result: 'PASS', operation: 'CREATE_SNAPSHOT', violationKinds: [], violationCount: 0 }),
      makeAuditRow({ result: 'BLOCK', operation: 'AUDIT_DIFF', violationKinds: ['out_of_scope_symbol', 'structural_change'], violationCount: 2 }),
      makeAuditRow({ result: 'PASS', operation: 'REVERT', violationKinds: [], violationCount: 0 }),
    ];

    await seedRows(store, rows);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(
      exportFineTuningDataset({ queryFn, projectIds: ['proj-test'] }),
    );

    expect(lines).toHaveLength(5);

    // Each line must parse to a valid FineTuningRecord via Zod
    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      const result = FineTuningRecordSchema.safeParse(parsed);
      expect(result.success, `Line failed schema validation: ${line}`).toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FT-3: sinceIso filter → only records >= that timestamp
// ---------------------------------------------------------------------------

describe('FT-3: sinceIso filter → only records >= sinceIso', () => {
  it('excludes records created before sinceIso', async () => {
    const store = await createIsolatedTestStore();

    const old = makeAuditRow({ createdAt: '2026-01-01T00:00:00.000Z' });
    const recent = makeAuditRow({ createdAt: '2026-04-10T12:00:00.000Z' });
    const future = makeAuditRow({ createdAt: '2026-12-01T00:00:00.000Z' });

    await seedRows(store, [old, recent, future]);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(
      exportFineTuningDataset({
        queryFn,
        sinceIso: '2026-04-01T00:00:00.000Z',
      }),
    );

    expect(lines).toHaveLength(2); // recent + future

    const records = lines.map((l) => JSON.parse(l) as { created_at: string });
    for (const r of records) {
      expect(r.created_at >= '2026-04-01T00:00:00.000Z').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FT-4: projectIds filter → only matching projects
// ---------------------------------------------------------------------------

describe('FT-4: projectIds filter → only matching projects', () => {
  it('excludes records for projects not in the projectIds list', async () => {
    const store = await createIsolatedTestStore();

    const rowA = makeAuditRow({ projectId: 'proj-a', runId: 'run-a' });
    const rowB = makeAuditRow({ projectId: 'proj-b', runId: 'run-b' });
    const rowC = makeAuditRow({ projectId: 'proj-c', runId: 'run-c' });

    await seedRows(store, [rowA, rowB, rowC]);

    // Query covers all three pairs, but projectIds filter restricts to proj-a and proj-c
    const queryFn = projectRunQueryFn(store, [
      { projectId: 'proj-a', runId: 'run-a' },
      { projectId: 'proj-b', runId: 'run-b' },
      { projectId: 'proj-c', runId: 'run-c' },
    ]);

    const lines = await collectLines(
      exportFineTuningDataset({ queryFn, projectIds: ['proj-a', 'proj-c'] }),
    );

    expect(lines).toHaveLength(2);

    const records = lines.map((l) => JSON.parse(l) as { project_id: string });
    const ids = records.map((r) => r.project_id);
    expect(ids).toContain('proj-a');
    expect(ids).toContain('proj-c');
    expect(ids).not.toContain('proj-b');
  });
});

// ---------------------------------------------------------------------------
// FT-5: format='json' → single JSON array string
// ---------------------------------------------------------------------------

describe('FT-5: format=json → single JSON array string', () => {
  it('yields exactly one string containing a JSON array', async () => {
    const store = await createIsolatedTestStore();

    const rows = [
      makeAuditRow({ result: 'PASS' }),
      makeAuditRow({ result: 'BLOCK', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
    ];
    await seedRows(store, rows);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(
      exportFineTuningDataset({ queryFn, format: 'json' }),
    );

    expect(lines).toHaveLength(1);

    const parsed = JSON.parse(lines[0]!) as unknown[];
    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    // Each array element must be a valid FineTuningRecord
    for (const item of parsed) {
      const result = FineTuningRecordSchema.safeParse(item);
      expect(result.success).toBe(true);
    }
  });

  it('empty result → single string "[]"', async () => {
    const store = await createIsolatedTestStore();
    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-none', runId: 'run-none' }]);
    const lines = await collectLines(
      exportFineTuningDataset({ queryFn, format: 'json' }),
    );

    expect(lines).toHaveLength(1);
    const parsed = JSON.parse(lines[0]!) as unknown;
    expect(Array.isArray(parsed)).toBe(true);
    expect((parsed as unknown[]).length).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// FT-6: format='jsonl' (default) → newline-delimited lines
// ---------------------------------------------------------------------------

describe('FT-6: format=jsonl (default) → one line per record', () => {
  it('each yielded string is a valid JSON object (not an array)', async () => {
    const store = await createIsolatedTestStore();

    await seedRows(store, [
      makeAuditRow({ result: 'PASS' }),
      makeAuditRow({ result: 'BLOCK', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
    ]);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);

    // Default format is jsonl
    const lines = await collectLines(exportFineTuningDataset({ queryFn }));

    expect(lines).toHaveLength(2);

    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      // Must be an object, not an array
      expect(typeof parsed).toBe('object');
      expect(Array.isArray(parsed)).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// FT-7: H13 verification — no content fields in output
// ---------------------------------------------------------------------------

describe('FT-7: H13 — no content beyond counts/kinds/ids in output', () => {
  it('output does not contain source content, symbol names, file paths, or manifest entries', async () => {
    const store = await createIsolatedTestStore();

    // Inject "sensitive" values into fields that must NOT appear in output.
    // The audit log schema only allows kind strings in violationKinds, but
    // we use realistic kind strings here and verify no bleed-through.
    const row = makeAuditRow({
      result: 'BLOCK',
      violationKinds: ['out_of_scope_symbol'],
      violationCount: 1,
      // These fields are on the AuditLogRecord but must NOT propagate
      // as content to the FineTuningRecord:
      engineId: 'engine-with-sensitive-id',
      correlationId: 'corr-do-not-leak',
    });

    await store.appendAuditLog(row);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(exportFineTuningDataset({ queryFn }));

    expect(lines).toHaveLength(1);

    const record = JSON.parse(lines[0]!) as Record<string, unknown>;

    // These fields must NOT appear in the export record
    expect(record).not.toHaveProperty('engine_id');
    expect(record).not.toHaveProperty('engineId');
    expect(record).not.toHaveProperty('correlation_id');
    expect(record).not.toHaveProperty('correlationId');
    expect(record).not.toHaveProperty('manifest');
    expect(record).not.toHaveProperty('entries');
    expect(record).not.toHaveProperty('path');
    expect(record).not.toHaveProperty('symbol');
    expect(record).not.toHaveProperty('source');
    expect(record).not.toHaveProperty('content');

    // The fields that ARE allowed
    expect(record).toHaveProperty('audit_id');
    expect(record).toHaveProperty('snapshot_id');
    expect(record).toHaveProperty('project_id');
    expect(record).toHaveProperty('run_id');
    expect(record).toHaveProperty('operation');
    expect(record).toHaveProperty('result');
    expect(record).toHaveProperty('violation_kinds');
    expect(record).toHaveProperty('violation_count');
    expect(record).toHaveProperty('ast_node_count');
    expect(record).toHaveProperty('file_line_count');
    expect(record).toHaveProperty('manifest_scope_ratio');
    expect(record).toHaveProperty('duration_ms');
    expect(record).toHaveProperty('created_at');
    expect(record).toHaveProperty('manifest_schema_version');

    // Verify all field values are counts/ids/kinds — no string paths
    const raw = lines[0]!;
    // No file path patterns (forward slash sequences that look like paths)
    // Violation kinds are just plain strings like 'out_of_scope_symbol'
    expect(raw).not.toMatch(/src\/|lib\/|dist\//);
  });
});

// ---------------------------------------------------------------------------
// FT-8: ERROR result rows are excluded from the export
// ---------------------------------------------------------------------------

describe('FT-8: ERROR result rows excluded', () => {
  it('excludes rows with result=ERROR from the output', async () => {
    const store = await createIsolatedTestStore();

    await seedRows(store, [
      makeAuditRow({ result: 'PASS' }),
      makeAuditRow({ result: 'ERROR' }),
      makeAuditRow({ result: 'BLOCK', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
    ]);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(exportFineTuningDataset({ queryFn }));

    expect(lines).toHaveLength(2); // PASS + BLOCK only

    const records = lines.map((l) => JSON.parse(l) as { result: string });
    for (const r of records) {
      expect(r.result).not.toBe('ERROR');
      expect(['PASS', 'BLOCK']).toContain(r.result);
    }
  });
});

// ---------------------------------------------------------------------------
// FT-9: writeFineTuningDatasetToFile — file content readable; count matches
// ---------------------------------------------------------------------------

describe('FT-9: writeFineTuningDatasetToFile — file content and count', () => {
  it('writes NDJSON file and returns correct recordCount', async () => {
    const store = await createIsolatedTestStore();
    const fs = createMemFsAdapter();

    const rows = [
      makeAuditRow({ result: 'PASS' }),
      makeAuditRow({ result: 'BLOCK', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
      makeAuditRow({ result: 'PASS', operation: 'CREATE_SNAPSHOT' }),
    ];
    await seedRows(store, rows);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const outPath = 'export/ft-dataset.jsonl';

    const { recordCount } = await writeFineTuningDatasetToFile({
      queryFn,
      fs,
      outPath,
    });

    expect(recordCount).toBe(3);

    // Read file back and verify each line is valid JSON
    const bytes = await fs.read(outPath);
    const content = new TextDecoder().decode(bytes);
    const lines = content.split('\n').filter((l) => l.trim().length > 0);

    expect(lines).toHaveLength(3);

    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      const result = FineTuningRecordSchema.safeParse(parsed);
      expect(result.success).toBe(true);
    }
  });

  it('format=json writes a JSON array file', async () => {
    const store = await createIsolatedTestStore();
    const fs = createMemFsAdapter();

    await seedRows(store, [
      makeAuditRow({ result: 'PASS' }),
      makeAuditRow({ result: 'BLOCK', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
    ]);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const outPath = 'export/ft-dataset.json';

    const { recordCount } = await writeFineTuningDatasetToFile({
      queryFn,
      format: 'json',
      fs,
      outPath,
    });

    expect(recordCount).toBe(2);

    const bytes = await fs.read(outPath);
    const content = new TextDecoder().decode(bytes);
    const parsed = JSON.parse(content) as unknown[];

    expect(Array.isArray(parsed)).toBe(true);
    expect(parsed).toHaveLength(2);

    for (const item of parsed) {
      const result = FineTuningRecordSchema.safeParse(item);
      expect(result.success).toBe(true);
    }
  });

  it('empty result → empty file, recordCount=0', async () => {
    const store = await createIsolatedTestStore();
    const fs = createMemFsAdapter();

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-none', runId: 'run-none' }]);
    const outPath = 'export/empty.jsonl';

    const { recordCount } = await writeFineTuningDatasetToFile({
      queryFn,
      fs,
      outPath,
    });

    expect(recordCount).toBe(0);

    const bytes = await fs.read(outPath);
    const content = new TextDecoder().decode(bytes);
    expect(content.trim()).toBe('');
  });
});

// ---------------------------------------------------------------------------
// FT-10: untilIso filter → only records <= that timestamp
// ---------------------------------------------------------------------------

describe('FT-10: untilIso filter → only records <= untilIso', () => {
  it('excludes records created after untilIso', async () => {
    const store = await createIsolatedTestStore();

    const early = makeAuditRow({ createdAt: '2026-01-01T00:00:00.000Z' });
    const mid = makeAuditRow({ createdAt: '2026-04-10T12:00:00.000Z' });
    const late = makeAuditRow({ createdAt: '2026-12-01T00:00:00.000Z' });

    await seedRows(store, [early, mid, late]);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(
      exportFineTuningDataset({
        queryFn,
        untilIso: '2026-06-01T00:00:00.000Z',
      }),
    );

    expect(lines).toHaveLength(2); // early + mid

    const records = lines.map((l) => JSON.parse(l) as { created_at: string });
    for (const r of records) {
      expect(r.created_at <= '2026-06-01T00:00:00.000Z').toBe(true);
    }
  });
});

// ---------------------------------------------------------------------------
// FT-11: projectIds filter — non-listed projects excluded
// ---------------------------------------------------------------------------

describe('FT-11: projectIds filter excludes non-listed projects', () => {
  it('only emits records for projects in the projectIds whitelist', async () => {
    const store = await createIsolatedTestStore();

    const rowAlpha = makeAuditRow({ projectId: 'proj-alpha', runId: 'run-alpha' });
    const rowBeta = makeAuditRow({ projectId: 'proj-beta', runId: 'run-beta' });

    await store.appendAuditLog(rowAlpha);
    await store.appendAuditLog(rowBeta);

    // Query covers both, but projectIds restricts to alpha only
    const queryFn = projectRunQueryFn(store, [
      { projectId: 'proj-alpha', runId: 'run-alpha' },
      { projectId: 'proj-beta', runId: 'run-beta' },
    ]);

    const lines = await collectLines(
      exportFineTuningDataset({ queryFn, projectIds: ['proj-alpha'] }),
    );

    expect(lines).toHaveLength(1);
    const record = JSON.parse(lines[0]!) as { project_id: string };
    expect(record.project_id).toBe('proj-alpha');
  });
});

// ---------------------------------------------------------------------------
// FT-12: FineTuningRecordSchema validates each emitted record
// ---------------------------------------------------------------------------

describe('FT-12: FineTuningRecordSchema validates all operation types', () => {
  it('all three operation mappings produce schema-valid records', async () => {
    const store = await createIsolatedTestStore();

    await seedRows(store, [
      makeAuditRow({ operation: 'CREATE_SNAPSHOT', result: 'PASS' }),
      makeAuditRow({ operation: 'AUDIT_DIFF', result: 'BLOCK', violationKinds: ['out_of_scope_symbol'], violationCount: 1 }),
      makeAuditRow({ operation: 'REVERT', result: 'PASS' }),
    ]);

    const queryFn = projectRunQueryFn(store, [{ projectId: 'proj-test', runId: 'run-test' }]);
    const lines = await collectLines(exportFineTuningDataset({ queryFn }));

    expect(lines).toHaveLength(3);

    const operations = new Set<string>();
    for (const line of lines) {
      const parsed = JSON.parse(line) as unknown;
      const result = FineTuningRecordSchema.safeParse(parsed);
      expect(result.success).toBe(true);
      if (result.success) {
        operations.add(result.data.operation);
      }
    }

    // All three operation kinds must be represented
    expect(operations.has('createSnapshot')).toBe(true);
    expect(operations.has('auditDiff')).toBe(true);
    expect(operations.has('revertUncontracted')).toBe(true);
  });
});
