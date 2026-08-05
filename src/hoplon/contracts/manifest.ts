/**
 * manifest.ts — WritableManifest Zod schemas and inferred types.
 *
 * Single source of truth for the writable scope contract.
 * TypeScript types are derived via z.infer<typeof schema>.
 * No hand-written TS types for DTOs.
 *
 * H15: manifest.entries.length max 1000.
 * H9: path traversal rejected at schema level (syntactic check;
 *     full canonicalization happens at the engine boundary in canonicalizePath).
 * H8: manifestSchemaVersion: 1 | 2 — cross-version reads are explicitly
 *     rejected, never silently re-interpreted. Version 3+ is rejected at the
 *     Zod level; the engine raises SemanticError({ kind: 'manifest_version_mismatch' })
 *     when a stored record's version differs from the engine's expected version.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// ManifestSchemaVersion — accepted versions
// ---------------------------------------------------------------------------

/**
 * Numeric schema version discriminator.
 * v1 — Phase 1 baseline (path + scope on entries; no intent; no signatureContracts).
 * v2 — Phase 2 additions (optional intent on entries; optional signatureContracts on manifest).
 * Any other value (e.g. 3) is rejected by Zod; engine raises manifest_version_mismatch.
 */
export const ManifestSchemaVersionSchema = z.union([z.literal(1), z.literal(2)]);
export type ManifestSchemaVersion = z.infer<typeof ManifestSchemaVersionSchema>;

// ---------------------------------------------------------------------------
// ManifestScope — discriminated union
// ---------------------------------------------------------------------------

export const ManifestScopeWholeFileSchema = z.object({
  kind: z.literal('whole_file'),
});

export const ManifestScopeSymbolsSchema = z.object({
  kind: z.literal('symbols'),
  symbols: z
    .array(z.string().min(1))
    .min(1, 'symbols scope must name at least one symbol'),
});

export const ManifestScopeSchema = z.discriminatedUnion('kind', [
  ManifestScopeWholeFileSchema,
  ManifestScopeSymbolsSchema,
]);

export type ManifestScope = z.infer<typeof ManifestScopeSchema>;

// ---------------------------------------------------------------------------
// ManifestIntent — per-entry target existence semantics (v2 only, optional)
// ---------------------------------------------------------------------------

/**
 * Per-entry intent declaration for target-existence validation.
 *
 * Consumed by Phase 2 LC1 (checkTargets):
 * - `'create'` → the symbol must NOT exist in the snapshot; if it does, LC1
 *   raises DUPLICATE_TARGET (prevents accidental duplication).
 * - `'modify'` → the symbol MUST exist in the snapshot; if it doesn't, LC1
 *   raises TARGET_NOT_FOUND (prevents phantom-target edits).
 * - omitted (v1 manifests or v2 without intent) → no target-existence check
 *   is performed; backward-compatible behavior.
 *
 * v1 manifests have no intent field and produce no target-existence violations.
 */
export const ManifestIntentSchema = z.enum(['create', 'modify']);
export type ManifestIntent = z.infer<typeof ManifestIntentSchema>;

// ---------------------------------------------------------------------------
// ManifestEntry
// ---------------------------------------------------------------------------

export const ManifestEntrySchema = z.object({
  /**
   * POSIX-style relative path, no '..', no leading '/', no Windows absolute.
   * Max length 4096 (H15).
   * This is a syntactic check — full canonicalization (including symlink-out)
   * happens at the engine boundary via canonicalizePath (H9).
   */
  path: z
    .string()
    .min(1, 'path must be non-empty')
    .max(4096, 'path must not exceed 4096 characters')
    .refine((p) => !p.startsWith('/'), 'path must not be an absolute path')
    .refine(
      (p) => !/^[A-Za-z]:[/\\]/.test(p),
      'path must not be a Windows-style absolute path',
    )
    .refine(
      (p) =>
        !p
          .split(/[/\\]/)
          .some((seg) => seg === '..'),
      'path must not contain .. segments',
    ),
  scope: ManifestScopeSchema,
  /**
   * Optional per-entry intent (v2 only — omit for v1 manifests).
   * See ManifestIntentSchema TSDoc for semantics.
   */
  intent: ManifestIntentSchema.optional(),
});

export type ManifestEntry = z.infer<typeof ManifestEntrySchema>;

// ---------------------------------------------------------------------------
// SignatureContract — per-symbol signature declaration (v2 only)
// ---------------------------------------------------------------------------

/**
 * One parameter in a signature contract.
 */
export const SignatureParamSchema = z.object({
  name: z.string().min(1),
  type: z.string().min(1),
  /** Whether the parameter is optional (e.g. `foo?: string`). */
  optional: z.boolean().optional(),
});
export type SignatureParam = z.infer<typeof SignatureParamSchema>;

/**
 * Declaration of an expected function/method signature.
 *
 * Consumed by Phase 2 LC3 (checkSignatures): verifies that the symbol named
 * in `symbol` at `file` in the generated code matches the declared
 * `expectedParams` and `expectedReturn`. When generic or overload comparison
 * is ambiguous at the tree-sitter level, LC3 returns SIGNATURE_UNCERTAIN
 * rather than SIGNATURE_MISMATCH.
 *
 * v1 manifests omit `signatureContracts`; LC3 produces no signature
 * violations when the field is absent (backward-compatible).
 */
export const SignatureContractSchema = z.object({
  /** Relative path to the file that declares the symbol. */
  file: z.string().min(1),
  /** Name of the function, method, or exported symbol. */
  symbol: z.string().min(1),
  /**
   * Expected parameter list in declaration order.
   * Empty array means the function accepts no arguments.
   */
  expectedParams: z.array(SignatureParamSchema),
  /** Expected return type string (e.g. `'Promise<void>'`). */
  expectedReturn: z.string().min(1),
});
export type SignatureContract = z.infer<typeof SignatureContractSchema>;

// ---------------------------------------------------------------------------
// WritableManifest
// ---------------------------------------------------------------------------

/** @internal Canonical internal form — downstream code reads `entries` here. */
const WritableManifestObjectSchema = z.object({
  /**
   * manifestSchemaVersion: 1 (Phase 1) or 2 (Phase 2).
   * Any other value is rejected by Zod. Engine raises
   * SemanticError({ kind: 'manifest_version_mismatch' }) when a stored
   * record's version differs from the engine's expected version.
   */
  manifestSchemaVersion: ManifestSchemaVersionSchema,

  /**
   * projectId: non-empty ASCII, no whitespace.
   * Content-addressable hashing depends on this being stable across machines.
   */
  projectId: z
    .string()
    .min(1, 'projectId must be non-empty')
    .regex(/^\S+$/, 'projectId must not contain whitespace')
    .regex(/^[\x20-\x7E]+$/, 'projectId must be printable ASCII'),

  /**
   * runId: distinct per pipeline execution; cross-run replay protection.
   * Mismatch raises SemanticError({ kind: 'run_id_mismatch' }).
   */
  runId: z.string().min(1, 'runId must be non-empty'),

  /**
   * correlationId: caller-assigned trace ID (H11).
   * Mandatory; threaded from the top of the pipeline run.
   */
  correlationId: z.string().min(1, 'correlationId must be non-empty'),

  /**
   * entries: the contracted writable scope.
   * Max 1000 entries (H15). Min 1 entry.
   *
   * Callers may also supply `permitted_regions` on input as a backward-compat
   * alias (H18 — additive alias). The preprocess layer in WritableManifestSchema
   * normalises `permitted_regions` → `entries` before this schema runs.
   * Downstream code always reads `entries`; `permitted_regions` never appears
   * on the parsed output type.
   */
  entries: z
    .array(ManifestEntrySchema)
    .min(1, 'manifest must have at least one entry')
    .max(1000, 'manifest must not exceed 1000 entries'),

  /**
   * signatureContracts: optional array of per-symbol signature declarations (v2 only).
   * Omit entirely for v1 manifests. When present, consumed by Phase 2 LC3
   * (checkSignatures). Empty array and absent are both treated as "no signature check".
   * See SignatureContractSchema TSDoc for semantics.
   */
  signatureContracts: z.array(SignatureContractSchema).optional(),
});

/**
 * @internal Alias normalization layer for WritableManifestSchema.
 * Accepts `entries` and/or `permitted_regions`; validates conflict; normalizes
 * to `entries`-only before piping into WritableManifestObjectSchema.
 */
const WritableManifestInputSchema = z
  .object({
    manifestSchemaVersion: z.unknown(),
    projectId: z.unknown(),
    runId: z.unknown(),
    correlationId: z.unknown(),
    entries: z.array(z.unknown()).optional(),
    permitted_regions: z.array(z.unknown()).optional(),
    signatureContracts: z.unknown().optional(),
  })
  .passthrough()
  .superRefine((data, ctx) => {
    const hasEntries = data.entries !== undefined;
    const hasPermitted = data.permitted_regions !== undefined;

    if (!hasEntries && !hasPermitted) {
      // Neither field — delegate to the inner schema for the "entries required"
      // error; no additional issue needed here.
      return;
    }

    if (hasEntries && hasPermitted) {
      // Both supplied — check for conflict.
      const stableEntries = JSON.stringify(data.entries);
      const stablePermitted = JSON.stringify(data.permitted_regions);
      if (stableEntries !== stablePermitted) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['permitted_regions'],
          message:
            'permitted_regions and entries conflict: both fields were provided but contain different values',
        });
      }
    }
  })
  .transform((data) => {
    const hasEntries = data.entries !== undefined;
    const hasPermitted = data.permitted_regions !== undefined;

    if (hasPermitted && !hasEntries) {
      // Promote permitted_regions → entries; strip the alias key.
      const { permitted_regions, ...rest } = data;
      return { ...rest, entries: permitted_regions };
    }

    if (hasPermitted) {
      // Both present and equal (conflict was caught above) — strip alias key.
      const { permitted_regions: _alias, ...rest } = data;
      return rest;
    }

    // entries-only or neither — pass through as-is.
    return data;
  });

/**
 * WritableManifestSchema — public schema for the writable scope contract.
 *
 * ALIGN-1 (H18 additive alias): accepts `permitted_regions` on input as an
 * alias for `entries`. Normalization rules:
 *
 *   - `entries` only      → passes through unchanged.
 *   - `permitted_regions` only → used as `entries`; `permitted_regions` key
 *     removed from the object before the inner schema runs.
 *   - both, identical value  → accepted; `permitted_regions` removed.
 *   - both, differing values → rejected with a Zod parse error on path
 *     `['permitted_regions']` ("permitted_regions and entries conflict").
 *   - neither              → rejected by the inner `entries` required field.
 *
 * The parsed output type (`WritableManifest`) never contains `permitted_regions`.
 * All downstream consumers read `entries` — unchanged by this alias layer.
 */
export const WritableManifestSchema = WritableManifestInputSchema.pipe(
  WritableManifestObjectSchema,
);

export type WritableManifest = z.infer<typeof WritableManifestObjectSchema>;
