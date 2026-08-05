/**
 * adapters/summarizer.ts — SummarizerAdapter interface (optional).
 *
 * ## Host-side LLM decision
 *
 * The host (Phalanx orchestration layer) owns the LLM / model choice entirely.
 * Hoplon ships only the seam — a contract for what a summarizer must accept
 * and return. Hoplon itself never calls this adapter internally; it is exposed
 * as an injection slot so that host code can wire its own LLM client here and
 * invoke it from host-side orchestration after receiving Hoplon results.
 *
 * ## H13 preserved
 *
 * Hoplon emits zero events from this adapter layer. Consumers choose whether to
 * call the summarizer from their own host code after receiving an AuditResult or
 * other Hoplon output. The adapter is a pure seam — the engine does not call it,
 * does not emit events about it, and does not log its output.
 *
 * ## Payload opacity
 *
 * The `payload` field of SummarizerInput is `unknown` intentionally. Hoplon does
 * not inspect or validate it beyond the TypeScript type boundary. Callers pass
 * whatever the LLM needs (e.g., AuditViolation[], CompressedRetryContext, etc.);
 * the adapter implementation is responsible for interpretation.
 *
 * ## No-op default
 *
 * createNoopSummarizer() is the factory default. It returns
 * { summary: '', tokenEstimate: 0, truncated: false } for every input —
 * zero cost, zero I/O, zero LLM calls.
 */

// ---------------------------------------------------------------------------
// SummarizerInput — what callers pass to the adapter
// ---------------------------------------------------------------------------

/**
 * Input to the summarizer adapter.
 *
 * kind: the semantic category of the payload.
 *   'diff'          — a structured AuditViolation[] (or diff-like structure)
 *                     that the adapter should explain as natural-language directives.
 *   'violations'    — an array of AuditViolation objects for explanation.
 *   'retry-context' — a CompressedRetryContext (or similar) for retry prompt injection.
 *
 * payload: opaque to Hoplon — passed through unchanged to the adapter implementation.
 *
 * maxTokens: advisory budget for the output summary. The adapter may respect or
 *   ignore it depending on the LLM's capabilities. When absent, the adapter uses
 *   its own default budget.
 *
 * abortSignal: optional AbortSignal for cooperative cancellation of LLM calls.
 *   Implementations should respect it; Hoplon does not enforce it.
 */
export interface SummarizerInput {
  /** Semantic category of the payload — determines how the adapter formats the prompt. */
  kind: 'diff' | 'violations' | 'retry-context';
  /**
   * Opaque payload. Hoplon does not inspect this.
   * Typical values: AuditViolation[], CompressedRetryContext, raw diff string.
   */
  payload: unknown;
  /**
   * Advisory token budget for the output summary.
   * Adapter may respect or ignore depending on LLM capabilities.
   * When absent: adapter uses its own default.
   */
  maxTokens?: number;
  /**
   * Optional AbortSignal for cooperative LLM call cancellation.
   * Hoplon does not enforce it; implementations should honor it.
   */
  abortSignal?: AbortSignal;
}

// ---------------------------------------------------------------------------
// SummarizerOutput — what the adapter returns
// ---------------------------------------------------------------------------

/**
 * Output from the summarizer adapter.
 *
 * summary: the human-readable summary. Empty string for the noop.
 *   Typically: natural-language correction directives, retry instructions,
 *   or a prose description of the diff / violations.
 *
 * tokenEstimate: rough token count of the summary. Implementation-defined.
 *   0 for the noop.
 *
 * truncated: true if the adapter truncated the output to respect maxTokens.
 *   false for the noop (empty output is never truncated).
 */
export interface SummarizerOutput {
  /** Human-readable summary. Empty string for the noop implementation. */
  summary: string;
  /**
   * Rough token count of the generated summary.
   * Implementation-defined (tokenizer may differ from the LLM used).
   * 0 for the noop.
   */
  tokenEstimate?: number;
  /**
   * Whether the adapter truncated the output to stay within maxTokens.
   * false for the noop.
   */
  truncated?: boolean;
}

// ---------------------------------------------------------------------------
// SummarizerAdapter interface
// ---------------------------------------------------------------------------

/**
 * Adapter seam for LLM-based summarization of Hoplon operation outputs.
 *
 * ## Seam-only contract
 *
 * The host owns the LLM / model choice. Hoplon ships only this interface.
 * No Hoplon operation (auditDiff, revertUncontracted, packContext, etc.) calls
 * this adapter — it is an injection slot for host-side orchestration code.
 *
 * ## H2 compliance
 *
 * This is an adapter, not engine logic. All LLM I/O lives behind this interface.
 * Engine core never imports LLM SDKs or model SDKs directly.
 *
 * ## H4 compliance
 *
 * Hoplon never owns retry or escalation policy for LLM calls. The host wires
 * its own retry logic around this adapter, or uses a model SDK that does so.
 *
 * ## H13 compliance
 *
 * Hoplon emits no events when or if the host calls this adapter. The adapter
 * sits outside the Hoplon event boundary; the host controls observability for
 * its own LLM calls.
 */
export interface SummarizerAdapter {
  /**
   * Produce a natural-language summary of the provided Hoplon operation output.
   *
   * @param input - The input to summarize, including kind, opaque payload,
   *   optional token budget, and optional abort signal.
   * @returns A SummarizerOutput with the summary string and optional metadata.
   *
   * The noop implementation always returns:
   *   { summary: '', tokenEstimate: 0, truncated: false }
   *
   * Phase 3 swap targets: any LLM client (Anthropic SDK, OpenAI SDK,
   * local model via llama.cpp bindings, etc.) that the host wires here.
   */
  summarize(input: SummarizerInput): Promise<SummarizerOutput>;
}

// ---------------------------------------------------------------------------
// No-op factory — default substitution
// ---------------------------------------------------------------------------

/**
 * Create a no-op SummarizerAdapter that returns an empty summary for all inputs.
 *
 * Returns { summary: '', tokenEstimate: 0, truncated: false } for every call,
 * regardless of kind or payload. Zero cost: no I/O, no model inference.
 *
 * Used as the default when the optional summarizer adapter is not provided
 * to createHoplonEngine(). The host provides a real implementation by passing
 * a SummarizerAdapter to the engine adapters when wiring the LLM client.
 *
 * Covers all three input kinds:
 *   'diff'          — returns empty summary
 *   'violations'    — returns empty summary
 *   'retry-context' — returns empty summary
 */
export function createNoopSummarizer(): SummarizerAdapter {
  return {
    async summarize(_input: SummarizerInput): Promise<SummarizerOutput> {
      return { summary: '', tokenEstimate: 0, truncated: false };
    },
  };
}
