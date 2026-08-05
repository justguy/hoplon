import { z } from 'zod';

const ByteRangeSchema = z.tuple([
  z.number().int().nonnegative(),
  z.number().int().nonnegative(),
]);

export const ScipIndexMetadataSchema = z.object({
  schemaVersion: z.literal(1),
  providerVersion: z.string().min(1),
  workspaceRevision: z.string().min(1),
  generatedAt: z.string().min(1),
});
export type ScipIndexMetadata = z.infer<typeof ScipIndexMetadataSchema>;

export const ScipOccurrenceSchema = z.object({
  symbol: z.string().min(1),
  role: z.enum(['definition', 'reference']),
  byteRange: ByteRangeSchema,
});
export type ScipOccurrence = z.infer<typeof ScipOccurrenceSchema>;

export const ScipDocumentSchema = z.object({
  path: z.string().min(1),
  dependencies: z.array(z.string().min(1)).default([]),
  occurrences: z.array(ScipOccurrenceSchema).default([]),
});
export type ScipDocument = z.infer<typeof ScipDocumentSchema>;

export const ScipSnapshotSchema = z.object({
  snapshotSchemaVersion: z.literal(1),
  metadata: ScipIndexMetadataSchema,
  documents: z.array(ScipDocumentSchema),
});
export type ScipSnapshot = z.infer<typeof ScipSnapshotSchema>;

export interface ScipReferenceResult {
  path: string;
  byteRange: [number, number];
}

export interface ScipIndexStateReady {
  status: 'ready';
  metadata: ScipIndexMetadata;
}

export interface ScipIndexStateStale {
  status: 'stale';
  metadata: ScipIndexMetadata;
  expectedWorkspaceRevision: string;
}

export type ScipIndexState = ScipIndexStateReady | ScipIndexStateStale;

export type ScipReadFile = (path: string) => Promise<Uint8Array>;

export interface CreateScipProviderOptions {
  indexPath: string;
  workspaceRevision?: string;
  readFile?: ScipReadFile;
}

export interface ScipProvider {
  getIndexState(): Promise<ScipIndexState>;
  findReferences(
    file: string,
    symbol: string,
  ): Promise<ScipReferenceResult[]>;
  findDependencies(filePath: string): Promise<string[]>;
}
