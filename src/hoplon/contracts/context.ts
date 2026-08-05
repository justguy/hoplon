/**
 * context.ts — PackedContext, PackedSlice, and PackFailure Zod schemas.
 *
 * PackedContext is the return shape of packContext().
 * It includes metadata (determinism tracking per H7), slices, and failures.
 * failures is always present — never empty-array suppressed.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// PackedSlice
// ---------------------------------------------------------------------------

export const PackedSliceSchema = z.object({
  /** File path relative to the fs adapter root, POSIX separators. */
  path: z.string().min(1),
  /** Byte range [start, end) of this slice within the file. */
  byteRange: z.tuple([z.number().int().nonnegative(), z.number().int().nonnegative()]),
  /** tree-sitter node kind names covered by this slice. */
  nodeKinds: z.array(z.string()),
  /** Verbatim source content of this slice. */
  content: z.string(),
});

export type PackedSlice = z.infer<typeof PackedSliceSchema>;

// ---------------------------------------------------------------------------
// PackFailure — discriminated union by reason
// ---------------------------------------------------------------------------

export const PackFailureFileTooLargeSchema = z.object({
  path: z.string().min(1),
  reason: z.literal('file_too_large'),
  sizeBytes: z.number().int().nonnegative(),
  limitBytes: z.number().int().positive(),
});

export const PackFailureParseFailureSchema = z.object({
  path: z.string().min(1),
  reason: z.literal('parse_failure'),
  parseError: z.string().min(1),
});

export const PackFailureParseTimeoutSchema = z.object({
  path: z.string().min(1),
  reason: z.literal('parse_timeout'),
  timeoutMs: z.number().int().positive(),
});

export const PackFailureUnsupportedExtensionSchema = z.object({
  path: z.string().min(1),
  reason: z.literal('unsupported_extension'),
  extension: z.string(),
});

export const PackFailureSchema = z.discriminatedUnion('reason', [
  PackFailureFileTooLargeSchema,
  PackFailureParseFailureSchema,
  PackFailureParseTimeoutSchema,
  PackFailureUnsupportedExtensionSchema,
]);

export type PackFailure = z.infer<typeof PackFailureSchema>;

// ---------------------------------------------------------------------------
// PackedContext
// ---------------------------------------------------------------------------

export const PackedContextSchema = z.object({
  metadata: z.object({
    /** Monotonically increasing strategy version — cache key for H7. */
    strategyVersion: z.number().int().nonnegative(),
    /** Grammar version string — cache key for H7. */
    grammarVersion: z.string(),
    /** Monotonically increasing packer implementation version — cache key for H7. */
    packerVersion: z.number().int().nonnegative(),
    /** ISO 8601 UTC timestamp when the context was generated. */
    generatedAt: z.string().datetime({ offset: false }),
    /** Correlation ID from the original request (H11). */
    correlationId: z.string().min(1),
  }),
  /** One slice per matched AST region. */
  slices: z.array(PackedSliceSchema),
  /** Per-file failures. Always present; may be empty. Never suppressed. */
  failures: z.array(PackFailureSchema),
});

export type PackedContext = z.infer<typeof PackedContextSchema>;
