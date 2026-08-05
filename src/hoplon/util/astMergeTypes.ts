export interface AstEdit {
  agentId: string;
  filePath: string;
  node: {
    byteRange: [number, number];
    kind?: string;
  };
  replacement: string;
}

export interface ConflictDescriptor {
  filePath: string;
  conflictingEdits: AstEdit[];
  reason: 'overlapping_ranges' | 'non_equivalent_replacements';
}

export interface MergeResultSuccess {
  kind: 'success';
  merged: Record<string, string>;
}

export interface MergeResultConflict {
  kind: 'conflict';
  conflicts: ConflictDescriptor[];
}

export type MergeResult = MergeResultSuccess | MergeResultConflict;

export interface MergeAstEditsOptions {
  equivalenceCheck?: (a: string, b: string) => Promise<boolean>;
}
