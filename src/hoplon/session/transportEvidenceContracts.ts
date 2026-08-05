import { z } from 'zod';

import { SessionRefSchema } from './transportRequestContracts.js';

/**
 * t-081 — packaged snapshot-evidence request body. The wrapper is a
 * discriminated union on `kind` so an invalid / unsupported request is
 * refused at parse time rather than reaching the composer. The schema
 * deliberately refuses any ref surface beyond:
 *
 *   - `fromSnapshotRefId` / `snapshotRefId` — a committed snapshotRefId
 *     the session is currently anchored on (enforced further at the
 *     composer).
 *   - `to` — either another `sha256:<hex>` / bare-hex committed
 *     snapshotRefId (cross-snapshot) or the literal sentinel `'live'`.
 *
 * Transport callers cannot hand in a branch name, tag, or HEAD-relative
 * ref — that is a deliberate contract-level narrowing of the surface.
 */
const SnapshotEvidenceRefSchema = z
  .string()
  .regex(
    /^(?:sha256:[0-9a-f]{64}|[0-9a-f]{64})$/,
    'snapshotRefId must be sha256:<64-hex> or a bare 64-char lowercase hex string',
  );

const SnapshotEvidenceDiffTargetSchema = z.union([
  z.literal('live'),
  SnapshotEvidenceRefSchema,
]);

const SessionSnapshotEvidenceDiffRequestBodySchema = z.object({
  kind: z.literal('diff'),
  fromSnapshotRefId: SnapshotEvidenceRefSchema,
  to: SnapshotEvidenceDiffTargetSchema,
  files: z.array(z.string().min(1)).optional(),
  contextLines: z.number().int().nonnegative().max(20).optional(),
});

const SessionSnapshotEvidenceProvenanceRequestBodySchema = z.object({
  kind: z.literal('provenance'),
  snapshotRefId: SnapshotEvidenceRefSchema,
});

const SnapshotEvidenceLineRangeSchema = z
  .object({
    startLine: z.number().int().positive(),
    endLine: z.number().int().positive(),
  })
  .refine((value) => value.endLine >= value.startLine, {
    message: 'endLine must be >= startLine',
  });

const SnapshotEvidenceLineTargetSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('line_range'),
    lineRange: SnapshotEvidenceLineRangeSchema,
  }),
  z.object({
    kind: z.literal('syntax_node'),
    syntaxNode: z.object({
      nodeKind: z.string().min(1).optional(),
      byteRange: z
        .tuple([z.number().int().nonnegative(), z.number().int().nonnegative()])
        .optional(),
      lineRange: SnapshotEvidenceLineRangeSchema,
    }),
  }),
]);

const SessionSnapshotEvidenceLineProvenanceRequestBodySchema = z.object({
  kind: z.literal('line_provenance'),
  snapshotRefId: SnapshotEvidenceRefSchema,
  file: z.string().min(1),
  target: SnapshotEvidenceLineTargetSchema,
});

export const SessionSnapshotEvidenceRequestSchema = SessionRefSchema.extend({
  request: z.discriminatedUnion('kind', [
    SessionSnapshotEvidenceDiffRequestBodySchema,
    SessionSnapshotEvidenceProvenanceRequestBodySchema,
    SessionSnapshotEvidenceLineProvenanceRequestBodySchema,
  ]),
});
export type SessionSnapshotEvidenceRequest = z.infer<
  typeof SessionSnapshotEvidenceRequestSchema
>;

/**
 * t-081 — per-file diff entry on the wire. Mirrors the in-process
 * `SnapshotEvidenceDiffFileEntry` with explicit status enum + unified-diff
 * text. Diff text is the text rendered by the shipped `renderUnifiedDiff`
 * helper — the transport contract never re-formats or truncates it.
 */
const SessionSnapshotEvidenceDiffFileEntrySchema = z.object({
  filepath: z.string().min(1),
  status: z.enum(['added', 'removed', 'modified', 'unchanged']),
  unifiedDiff: z.string(),
  beforeByteLength: z.number().int().nonnegative().nullable(),
  afterByteLength: z.number().int().nonnegative().nullable(),
});

const SessionSnapshotEvidenceDiffResultSchema = z.object({
  kind: z.literal('diff'),
  fromSnapshotRefId: SnapshotEvidenceRefSchema,
  toSnapshotRefId: SnapshotEvidenceDiffTargetSchema,
  files: z.array(SessionSnapshotEvidenceDiffFileEntrySchema),
  generatedAt: z.string().datetime({ offset: false }),
});

const SessionSnapshotEvidenceProvenanceResultSchema = z.object({
  kind: z.literal('provenance'),
  snapshotRefId: SnapshotEvidenceRefSchema,
  snapshotGitCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  engineId: z.string().min(1),
  projectId: z.string().min(1),
  runId: z.string().min(1),
  correlationId: z.string().min(1),
  manifestSchemaVersion: z.number().int().positive(),
  status: z.enum(['pending', 'committed', 'failed']),
  createdAt: z.string().datetime({ offset: false }),
  ttlExpires: z.string().datetime({ offset: false }).nullable(),
  manifestEntryCount: z.number().int().nonnegative(),
  commit: z.object({
    treeOid: z.string().regex(/^[0-9a-f]{40}$/),
    parentOids: z.array(z.string().regex(/^[0-9a-f]{40}$/)),
    committerTimestamp: z.number().int().nonnegative(),
    authorTimestamp: z.number().int().nonnegative(),
    messageFirstLine: z.string(),
  }),
  generatedAt: z.string().datetime({ offset: false }),
});

const SessionSnapshotEvidenceLineProvenanceResultSchema = z.object({
  kind: z.literal('line_provenance'),
  snapshotRefId: SnapshotEvidenceRefSchema,
  snapshotGitCommitSha: z.string().regex(/^[0-9a-f]{40}$/),
  file: z.string().min(1),
  target: SnapshotEvidenceLineTargetSchema,
  lineRange: SnapshotEvidenceLineRangeSchema,
  commit: z.object({
    commitId: z.string().regex(/^[0-9a-f]{40}$/),
    parentOids: z.array(z.string().regex(/^[0-9a-f]{40}$/)),
    authorName: z.string(),
    authorTimestamp: z.number().int().nonnegative(),
    committerTimestamp: z.number().int().nonnegative(),
    messageFirstLine: z.string(),
  }),
  provenanceKind: z.enum(['line_changed', 'file_added_at_path']),
  generatedAt: z.string().datetime({ offset: false }),
});

export const SessionSnapshotEvidenceResultSchema = z.union([
  SessionSnapshotEvidenceDiffResultSchema,
  SessionSnapshotEvidenceProvenanceResultSchema,
  SessionSnapshotEvidenceLineProvenanceResultSchema,
]);
export type SessionSnapshotEvidenceResult = z.infer<
  typeof SessionSnapshotEvidenceResultSchema
>;
export const GetSnapshotEvidenceSessionResponseDataSchema = z.object({
  evidence: SessionSnapshotEvidenceResultSchema,
});
