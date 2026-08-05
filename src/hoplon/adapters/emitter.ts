/**
 * adapters/emitter.ts — HoplonEmitter interface and HoplonEvent Zod schema.
 *
 * H13: Operational logs contain structure only, never content.
 * Symbol names, sourceSlices, AST node values, manifest paths beyond counts
 * never enter the HoplonEvent stream.
 *
 * The HoplonEvent schema uses .strict() to reject any unknown fields at parse
 * time — this enforces H13 at the schema level. A caller adding a content field
 * will get a Zod validation error.
 *
 * Phase 1 default: createNoopEmitter() — drops all events.
 * Test/debug: createConsoleEmitter() — writes structured JSON to stdout.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// HoplonEvent Zod schema — .strict() enforces H13
// ---------------------------------------------------------------------------

export const HoplonEventSchema = z
  .object({
    op: z.enum([
      'createSnapshot',
      'auditDiff',
      'revertUncontracted',
      'packContext',
      'health',
      'reconcile',
      'session',
      'dryRun',
      'preflight',
      'applyEdits',
      'markEdited',
      'stageContent',
      'queryStructure',
      'extractStructuralTemplate',
      'getRelevantTests',
      'extractRollbackTemplate',
      'getRepairContext',
      'getCloseoutProofBundle',
      'getReviewPayload',
      'verifyBehavior',
      'getSnapshotEvidence',
      'policyDecision',
      'describeCapabilities',
      /**
       * 't-056' — local AST-aware structural search.
       * H13-compliant: counts and phase only.
       */
      'searchSymbols',
      /**
       * 't-056' — local AST-aware project orientation.
       * H13-compliant: counts and phase only.
       */
      'describeProject',
      /**
       * 't-036' — advisory violation-risk predictor consumer.
       * H13-compliant: counts, sampleSize, band only. Never content or paths.
       */
      'predictViolationRisk',
      /**
       * 't-037' — advisory anomaly-detector consumer.
       * H13-compliant: counts, sampleSize, signal counts only. No metric values
       * ever touch content; metric names come from a closed enum.
       */
      'scoreAnomaly',
      /**
       * 't-027' — advisory blast-radius consumer over
       * `codeIntelligence.findReferences`. H13-compliant: counts + phase only;
       * no symbol names or affected-file paths flow through the event stream.
       */
      'analyzeBlastRadius',
      /**
       * 't-118' — advisory referencing-symbol lookup over the same optional
       * findReferences seam. H13-compliant: counts + phase only; no symbol
       * names or reference paths flow through the event stream.
       */
      'findReferencingSymbols',
      /**
       * 't-120' — advisory syntax-node lookup. H13-compliant: counts and
       * lifecycle only; node text and file content stay on returned DTOs.
       */
      'findSyntaxNode',
      /**
       * 't-034' — first real Layer 1 semantic-search retrieval consumer.
       * H13-compliant: counts + phase + status only. No query text, document
       * ids, document text, or metadata values flow through the event stream.
       */
      'semanticSearch',
      /**
       * 't-034' — semantic-corpus indexing consumer. H13-compliant:
       * indexedCount + requestedCount + phase only.
       */
      'indexSemanticCorpus',
      /**
       * 't-028' — deterministic interface-stub synthesis over manifest-truth
       * SignatureContracts. H13-compliant: target / authoritative / placeholder
       * counts only; no symbol names, type strings, or declaration bodies flow
       * through the event stream.
       */
      'synthesizeInterfaceStubs',
      /**
       * 't-108' - ephemeral structural sandbox. H13-compliant: operation
       * lifecycle only; snippet content, paths, symbols, and node kinds stay
       * on the returned DTO, never in events.
       */
      'ephemeralStructuralSandbox',
      /**
       * 't-061' — unified agent-facing read/search macro. H13-compliant:
       * phase + classification + duration only; no paths, no routing text,
       * no payload bytes leak into the event stream (routing detail lives
       * on the `see_codebase` response envelope, not the event log).
       */
      'seeCodebase',
      /**
       * 'factory' — factory-time lifecycle events (e.g. deprecated adapter warnings).
       * Structure-only per H13: no adapter values, no paths, no content.
       */
      'factory',
      /**
       * 'convergence' — monotone reduction telemetry (Track CV).
       * Emitted by emitConvergenceEvent in util/convergence.ts.
       * Carries only counts, booleans, and enum values per H13.
       */
      'convergence',
    ]),
    phase: z.enum(['start', 'end', 'error']),
    /** Duration in milliseconds — present on 'end' and 'error' phases. */
    durationMs: z.number().nonnegative().optional(),
    /** Classification of the operation result. */
    classification: z.enum(['PASS', 'BLOCK', 'ERROR']).optional(),
    /** Structural taxonomy bucket for consumers such as OTel dashboards. */
    operationKind: z
      .enum(['read', 'write', 'policy', 'session', 'review', 'lifecycle', 'analysis'])
      .optional(),
    /** Closed class for policy/authorization decisions. No principal or rule data. */
    policyDecisionClass: z
      .enum([
        'allow',
        'deny',
        'requires_escalation',
        'requires_approval',
        'reauth_required',
        'revoked',
        'error',
      ])
      .optional(),
    /** Engine identity (H5). Always present. */
    engineId: z.string().min(1),
    /** Project context — present when known. */
    projectId: z.string().optional(),
    /** Run context — present when known. */
    runId: z.string().optional(),
    /** Mandatory trace ID (H11). */
    correlationId: z.string().min(1),
    /**
     * Error category — present on 'error' phase.
     * Maps to the four-class taxonomy.
     */
    errorCategory: z
      .enum(['engine', 'adapter', 'semantic', 'validation'])
      .optional(),
    /** Error kind (fine-grained discriminator within the category). */
    errorKind: z.string().optional(),
    // Counts and sizes only — explicitly NEVER:
    //   file content, manifest entries, AST node values,
    //   sourceSlice fragments, symbol names, paths beyond counts
    inputCount: z.number().int().nonnegative().optional(),
    outputCount: z.number().int().nonnegative().optional(),
    resultCount: z.number().int().nonnegative().optional(),
    fileCount: z.number().int().nonnegative().optional(),
    changedFileCount: z.number().int().nonnegative().optional(),
    subjectCount: z.number().int().nonnegative().optional(),
    documentCount: z.number().int().nonnegative().optional(),
    violationCount: z.number().int().nonnegative().optional(),
    auditRowCount: z.number().int().nonnegative().optional(),
    byteCount: z.number().int().nonnegative().optional(),
    attemptCount: z.number().int().nonnegative().optional(),

    // ---------------------------------------------------------------------------
    // Convergence telemetry fields (Track CV, op='convergence').
    // Present only on convergence events; H13-compliant: counts, booleans, enums.
    // ---------------------------------------------------------------------------

    /** Total number of attempts in the convergence window (op='convergence'). */
    convergenceAttemptCount: z.number().int().nonnegative().optional(),
    /**
     * Whether each attempt's violation count ≤ the prior attempt's count.
     * Present on op='convergence' events.
     */
    convergenceMonotonicDecrease: z.boolean().optional(),
    /**
     * Persistent violations / total unique violations across attempts.
     * Range [0, 1]. Present on op='convergence' events.
     */
    convergencePersistentViolationRatio: z.number().min(0).max(1).optional(),
    /**
     * Divergence risk heuristic — 'low' | 'medium' | 'high'.
     * Present on op='convergence' events.
     */
    convergenceDivergenceRisk: z.enum(['low', 'medium', 'high']).optional(),
    /**
     * Per-attempt violation counts in ascending attempt order (numeric array).
     * Each element is a non-negative integer. Present on op='convergence' events.
     * H13: purely numeric counts — no symbol names, paths, or content.
     */
    convergenceViolationCountSeries: z.array(z.number().int().nonnegative()).optional(),
  })
  .strict(); // H13: reject any unknown fields

export type HoplonEvent = z.infer<typeof HoplonEventSchema>;

// ---------------------------------------------------------------------------
// HoplonEmitter interface
// ---------------------------------------------------------------------------

export interface HoplonEmitter {
  /**
   * Emit an operational event.
   * Implementations MUST NOT block — fire-and-forget semantics.
   * Errors in the emitter must never propagate to the caller.
   */
  emit(event: HoplonEvent): void;
}
