/**
 * contracts/interfaceStubs.ts — t-028 deterministic interface-stub DTOs.
 *
 * The bounded `synthesizeInterfaceStubs` operation emits declaration artifacts
 * for the set of caller-supplied targets using manifest-truth
 * `signatureContracts` as the authoritative source. It is additive to the
 * shipped manifest v2 surface; it never widens audit, DLP, or blast-radius
 * semantics and never blocks any PASS/BLOCK path.
 *
 * ## Scope (bounded per the t-028 handoff)
 * - Inputs are caller-supplied `targets` and an explicit `signatureContracts`
 *   list. The operation does not re-derive contracts from a stored manifest —
 *   the caller (typically a parallel-workflow coordinator) owns that choice.
 * - Output per target is either `authoritative` (a matching contract exists
 *   and a full declaration is emitted) or `placeholder` (no contract — the
 *   declaration is `export declare const <symbol>: unknown;` with an explicit
 *   `reason`). Placeholder output is marked explicitly partial rather than
 *   silently treated as complete.
 * - No ts-morph dependency is added. The operation uses the existing
 *   TypeScript compiler API as the declaration-aware generator over already
 *   validated Zod contracts.
 * - Generics, overloads, and SIGNATURE_UNCERTAIN-class contracts round-trip
 *   as-is — the declaration string is the contract string, byte-for-byte.
 *
 * ## Determinism (H7)
 * Stubs are sorted by (targetFile, targetSymbol). Same input → byte-identical
 * output across calls.
 *
 * ## H13 compliance
 * The HoplonEvent payload emitted by the operation carries only counts
 * (targetCount, authoritativeCount, placeholderCount). Symbol names, type
 * strings, and declaration bodies are never logged.
 */

import { z } from 'zod';
import { SignatureContractSchema } from './manifest.js';

// ---------------------------------------------------------------------------
// InterfaceStubTarget — a (file, symbol) pair the caller wants a stub for.
// ---------------------------------------------------------------------------

export const InterfaceStubTargetSchema = z.object({
  /** Relative path to the file that should declare the symbol. */
  file: z.string().min(1),
  /** Name of the function / method / exported symbol to stub. */
  symbol: z.string().min(1),
});
export type InterfaceStubTarget = z.infer<typeof InterfaceStubTargetSchema>;

// ---------------------------------------------------------------------------
// Stub quality + reason
// ---------------------------------------------------------------------------

export const STUB_QUALITIES = ['authoritative', 'placeholder'] as const;
export const StubQualitySchema = z.enum(STUB_QUALITIES);
export type StubQuality = z.infer<typeof StubQualitySchema>;

/**
 * Why a stub is a placeholder. `null` on authoritative stubs. The enum is
 * closed on purpose — callers can branch on it without string-matching.
 *
 * - `'no_signature_contract'`: no SignatureContract matched (file, symbol).
 */
export const STUB_PLACEHOLDER_REASONS = ['no_signature_contract'] as const;
export const StubPlaceholderReasonSchema = z.enum(STUB_PLACEHOLDER_REASONS);
export type StubPlaceholderReason = z.infer<typeof StubPlaceholderReasonSchema>;

// ---------------------------------------------------------------------------
// InterfaceStub — one per target
// ---------------------------------------------------------------------------

export const InterfaceStubSchema = z
  .object({
    target: InterfaceStubTargetSchema,
    quality: StubQualitySchema,
    /**
     * The emitted TypeScript declaration text. For authoritative stubs this
     * contains one or more `export declare function …;` lines (one per
     * matching SignatureContract in source order). For placeholders this is
     * `export declare const <symbol>: unknown;` — syntactically valid but
     * explicitly non-authoritative.
     */
    declaration: z.string().min(1),
    /**
     * Placeholder reason. `null` when `quality === 'authoritative'`. Required
     * and non-null when `quality === 'placeholder'`.
     */
    reason: StubPlaceholderReasonSchema.nullable(),
    /**
     * Count of matching SignatureContracts that fed this stub. 0 for
     * placeholders; ≥1 for authoritative stubs (overloads allowed). Echoed
     * so callers can detect overload-class input deterministically.
     */
    contractCount: z.number().int().nonnegative(),
  })
  .superRefine((stub, ctx) => {
    if (stub.quality === 'authoritative') {
      if (stub.reason !== null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'authoritative stubs must carry reason=null',
        });
      }
      if (stub.contractCount < 1) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contractCount'],
          message: 'authoritative stubs must have contractCount>=1',
        });
      }
    } else {
      if (stub.reason === null) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['reason'],
          message: 'placeholder stubs must carry a non-null reason',
        });
      }
      if (stub.contractCount !== 0) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['contractCount'],
          message: 'placeholder stubs must have contractCount=0',
        });
      }
    }
  });
export type InterfaceStub = z.infer<typeof InterfaceStubSchema>;

// ---------------------------------------------------------------------------
// SynthesizeInterfaceStubsResult
// ---------------------------------------------------------------------------

export const STUBS_STATUSES = [
  /** Every target produced an authoritative declaration. */
  'AUTHORITATIVE',
  /** Some targets are authoritative, some are placeholders. */
  'PARTIAL',
  /** No target had a matching contract — every stub is a placeholder. */
  'PLACEHOLDER_ONLY',
] as const;
export const SynthesizeInterfaceStubsStatusSchema = z.enum(STUBS_STATUSES);
export type SynthesizeInterfaceStubsStatus = z.infer<
  typeof SynthesizeInterfaceStubsStatusSchema
>;

export const SynthesizeInterfaceStubsResultSchema = z.object({
  correlationId: z.string().min(1),
  /**
   * Advisory-only: this operation never participates in a PASS/BLOCK path.
   * Pinned to `true` so a misbehaving adapter cannot silently widen the seam.
   */
  advisory: z.literal(true),
  status: SynthesizeInterfaceStubsStatusSchema,
  /**
   * Per-target stubs, sorted by (file, symbol) for H7 determinism.
   * Includes every target the caller asked for, even when the stub is a
   * placeholder.
   */
  stubs: z.array(InterfaceStubSchema),
  /** Count of stubs whose quality === 'authoritative'. */
  authoritativeCount: z.number().int().nonnegative(),
  /** Count of stubs whose quality === 'placeholder'. */
  placeholderCount: z.number().int().nonnegative(),
});
export type SynthesizeInterfaceStubsResult = z.infer<
  typeof SynthesizeInterfaceStubsResultSchema
>;

// ---------------------------------------------------------------------------
// SynthesizeInterfaceStubsRequest
// ---------------------------------------------------------------------------

export const SynthesizeInterfaceStubsRequestSchema = z.object({
  correlationId: z.string().min(1),
  /** Optional project scoping for telemetry. */
  projectId: z.string().min(1).optional(),
  /**
   * The (file, symbol) pairs the caller wants declaration stubs for. At least
   * one target is required. Duplicate targets collapse to one stub in the
   * result (unique by `(file, symbol)`).
   */
  targets: z.array(InterfaceStubTargetSchema).min(1),
  /**
   * SignatureContracts the caller trusts as authoritative truth. Usually the
   * `signatureContracts` field of a manifest v2 WritableManifest. Empty /
   * omitted → every target becomes a placeholder stub.
   *
   * Multiple contracts may match the same (file, symbol) — overload-class
   * input. The operation emits one declaration line per matching contract,
   * in source order, and reports the contract count on the stub.
   */
  signatureContracts: z.array(SignatureContractSchema).optional(),
});
export type SynthesizeInterfaceStubsRequest = z.infer<
  typeof SynthesizeInterfaceStubsRequestSchema
>;
