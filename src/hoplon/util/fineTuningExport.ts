/** Content-free audit-log export for ML training datasets. */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import { toFineTuningRecord } from './fineTuningRecords.js';
import type { FineTuningRecord } from './fineTuningRecords.js';
import type { ExportFilters, QueryFn } from './fineTuningQueries.js';

export { FineTuningRecordSchema } from './fineTuningRecords.js';
export type { FineTuningRecord } from './fineTuningRecords.js';
export {
  defaultQueryFn,
  projectRunQueryFn,
} from './fineTuningQueries.js';
export type { ExportFilters, QueryFn } from './fineTuningQueries.js';

export interface ExportOptions extends ExportFilters {
  queryFn: QueryFn;
  /** `jsonl` streams records; `json` buffers one JSON array. */
  format?: 'jsonl' | 'json';
}

export async function* exportFineTuningDataset(
  opts: ExportOptions,
): AsyncIterable<string> {
  const { queryFn, format = 'jsonl', ...filters } = opts;

  if (format === 'json') {
    const records: FineTuningRecord[] = [];
    for await (const row of queryFn(filters)) {
      const record = toFineTuningRecord(row);
      if (record !== null) records.push(record);
    }
    yield JSON.stringify(records);
    return;
  }

  for await (const row of queryFn(filters)) {
    const record = toFineTuningRecord(row);
    if (record !== null) yield JSON.stringify(record);
  }
}

export interface WriteOptions extends ExportOptions {
  fs: HoplonFsAdapter;
  outPath: string;
}

export async function writeFineTuningDatasetToFile(
  opts: WriteOptions,
): Promise<{ recordCount: number }> {
  const { fs, outPath, ...exportOpts } = opts;
  const encoder = new TextEncoder();
  const lines: string[] = [];

  for await (const line of exportFineTuningDataset(exportOpts)) {
    lines.push(line);
  }

  const format = exportOpts.format ?? 'jsonl';
  let fileContent: string;
  if (format === 'json') {
    fileContent = lines[0] ?? '[]';
  } else {
    fileContent = lines.join('\n');
  }
  await fs.write(outPath, encoder.encode(fileContent));

  let recordCount: number;
  if (format === 'json') {
    try {
      const parsed = JSON.parse(fileContent) as unknown[];
      recordCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch {
      recordCount = 0;
    }
  } else {
    recordCount = lines.filter((line) => line.trim().length > 0).length;
  }
  return { recordCount };
}
