import type { AstEdit, ConflictDescriptor } from './astMergeTypes.js';

interface PerFileResult {
  filePath: string;
  mergedContent?: string;
  conflicts: ConflictDescriptor[];
}

function byteRangesOverlap(
  a: [number, number],
  b: [number, number],
): boolean {
  return a[0] < b[1] && b[0] < a[1];
}

export async function defaultEquivalenceCheck(
  a: string,
  b: string,
): Promise<boolean> {
  return a === b;
}

function applyEditsRightToLeft(content: string, edits: AstEdit[]): string {
  const sorted = edits
    .slice()
    .sort((a, b) => b.node.byteRange[0] - a.node.byteRange[0]);
  let result = content;
  for (const edit of sorted) {
    const [start, end] = edit.node.byteRange;
    result = result.slice(0, start) + edit.replacement + result.slice(end);
  }
  return result;
}

export async function mergeFileEdits(
  filePath: string,
  edits: AstEdit[],
  originalContent: string,
  equivalenceCheck: (a: string, b: string) => Promise<boolean>,
): Promise<PerFileResult> {
  if (edits.length === 0) {
    return { filePath, mergedContent: originalContent, conflicts: [] };
  }
  if (edits.length === 1) {
    const merged = applyEditsRightToLeft(originalContent, edits);
    return { filePath, mergedContent: merged, conflicts: [] };
  }

  const n = edits.length;
  const overlapsWith: Set<number>[] = Array.from(
    { length: n },
    () => new Set<number>(),
  );
  for (let i = 0; i < n; i++) {
    for (let j = i + 1; j < n; j++) {
      if (byteRangesOverlap(edits[i]!.node.byteRange, edits[j]!.node.byteRange)) {
        overlapsWith[i]!.add(j);
        overlapsWith[j]!.add(i);
      }
    }
  }

  const parent = Array.from({ length: n }, (_, i) => i);
  function find(x: number): number {
    while (parent[x] !== x) {
      parent[x] = parent[parent[x]!]!;
      x = parent[x]!;
    }
    return x;
  }
  function union(x: number, y: number): void {
    const px = find(x);
    const py = find(y);
    if (px !== py) parent[px] = py;
  }
  for (let i = 0; i < n; i++) {
    for (const j of overlapsWith[i]!) union(i, j);
  }

  const clusters = new Map<number, number[]>();
  for (let i = 0; i < n; i++) {
    const root = find(i);
    const group = clusters.get(root);
    if (group === undefined) clusters.set(root, [i]);
    else group.push(i);
  }

  const survivingEdits: AstEdit[] = [];
  const conflicts: ConflictDescriptor[] = [];
  for (const [, indices] of clusters) {
    if (indices.length === 1) {
      survivingEdits.push(edits[indices[0]!]!);
      continue;
    }
    const clusterEdits = indices.map((i) => edits[i]!);
    let allEquivalent = true;
    outer: for (let a = 0; a < clusterEdits.length; a++) {
      for (let b = a + 1; b < clusterEdits.length; b++) {
        const equivalent = await equivalenceCheck(
          clusterEdits[a]!.replacement,
          clusterEdits[b]!.replacement,
        );
        if (!equivalent) {
          allEquivalent = false;
          break outer;
        }
      }
    }

    if (allEquivalent) {
      const representative = clusterEdits.reduce((best, current) =>
        edits.indexOf(best) <= edits.indexOf(current) ? best : current,
      );
      survivingEdits.push(representative);
    } else {
      const allSameRange = clusterEdits.every(
        (edit) =>
          edit.node.byteRange[0] === clusterEdits[0]!.node.byteRange[0] &&
          edit.node.byteRange[1] === clusterEdits[0]!.node.byteRange[1],
      );
      const reason: ConflictDescriptor['reason'] = allSameRange
        ? 'non_equivalent_replacements'
        : 'overlapping_ranges';
      conflicts.push({ filePath, conflictingEdits: clusterEdits, reason });
    }
  }

  if (conflicts.length > 0) return { filePath, conflicts };
  const mergedContent = applyEditsRightToLeft(originalContent, survivingEdits);
  return { filePath, mergedContent, conflicts: [] };
}
