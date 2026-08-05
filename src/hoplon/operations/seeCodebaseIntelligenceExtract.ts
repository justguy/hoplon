import type { SeeCodebaseReadProvenance } from '../contracts/seeCodebase.js';
import type { ReadAstNodeIdentity } from '../contracts/seeCodebaseIntelligence.js';

export function extractAstNodeIdentities(
  payload: unknown,
  resultIndex: number,
  readProvenance: SeeCodebaseReadProvenance,
): ReadAstNodeIdentity[] {
  const source = asRecord(payload);
  if (source === undefined) return [];
  return [
    ...arrayField(source, 'matches').flatMap((match) =>
      identityFromMatch(match, resultIndex, readProvenance),
    ),
    ...arrayField(source, 'slices').flatMap((slice) =>
      identityFromSlice(slice, resultIndex, readProvenance),
    ),
  ];
}

export function summarizePayloadShape(payload: unknown): Record<string, number> {
  const source = asRecord(payload);
  if (source === undefined) return {};
  const out: Record<string, number> = {};
  setCount(out, 'matches', arrayField(source, 'matches').length);
  setCount(out, 'failures', arrayField(source, 'failures').length);
  setCount(out, 'slices', arrayField(source, 'slices').length);
  const files = arrayField(source, 'files');
  setCount(out, 'files', files.length);
  let exportsCount = 0;
  let importsCount = 0;
  let typesCount = 0;
  for (const file of files) {
    const record = asRecord(file);
    if (record === undefined) continue;
    exportsCount += arrayField(record, 'exports').length;
    importsCount += arrayField(record, 'imports').length;
    typesCount += arrayField(record, 'types').length;
  }
  setCount(out, 'exports', exportsCount);
  setCount(out, 'imports', importsCount);
  setCount(out, 'types', typesCount);
  return out;
}

function identityFromMatch(
  value: unknown,
  resultIndex: number,
  readProvenance: SeeCodebaseReadProvenance,
): ReadAstNodeIdentity[] {
  const match = asRecord(value);
  if (match === undefined) return [];
  const path = stringField(match, 'path');
  const byteRange = byteRangeField(match, 'byteRange');
  if (path === undefined || byteRange === undefined) return [];
  const kind = stringField(match, 'kind') ?? 'symbol';
  const nodeKind = stringField(match, 'nodeKind') ?? kind;
  const name = stringField(match, 'name');
  return [{
    resultIndex,
    path,
    ...(name !== undefined ? { name } : {}),
    kind,
    nodeKind,
    byteRange,
    readProvenance,
  }];
}

function identityFromSlice(
  value: unknown,
  resultIndex: number,
  readProvenance: SeeCodebaseReadProvenance,
): ReadAstNodeIdentity[] {
  const slice = asRecord(value);
  if (slice === undefined) return [];
  const path = stringField(slice, 'path');
  const byteRange = byteRangeField(slice, 'byteRange');
  if (path === undefined || byteRange === undefined) return [];
  const nodeKinds = arrayField(slice, 'nodeKinds').filter(isString);
  const nodeKind = nodeKinds[0] ?? 'packed_slice';
  return [{
    resultIndex,
    path,
    kind: 'packed_slice',
    nodeKind,
    byteRange,
    readProvenance,
  }];
}

function setCount(out: Record<string, number>, key: string, count: number): void {
  if (count > 0) out[key] = count;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return undefined;
  }
  return value as Record<string, unknown>;
}

function arrayField(record: Record<string, unknown>, key: string): unknown[] {
  const value = record[key];
  return Array.isArray(value) ? value : [];
}

function stringField(
  record: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = record[key];
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function byteRangeField(
  record: Record<string, unknown>,
  key: string,
): [number, number] | undefined {
  const value = record[key];
  if (!Array.isArray(value) || value.length !== 2) return undefined;
  const [start, end] = value;
  return Number.isInteger(start) &&
    Number.isInteger(end) &&
    start >= 0 &&
    end >= 0
    ? [start, end]
    : undefined;
}

function isString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
