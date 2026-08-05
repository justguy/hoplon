/**
 * adapters/emitter/noop.ts — Zero-cost no-op emitter.
 *
 * Design decision (C5):
 * The noop emitter does NOT validate event shapes. H13 content-free
 * enforcement is already handled at the schema level by HoplonEventSchema
 * .strict() in the A3.1 contract tests. The noop emitter's sole purpose is
 * zero-cost event dropping in Phase 1 production — adding a Zod parse call
 * would contradict that intent. Validation is the caller's responsibility at
 * emit time; callers that need enforcement in dev/test should use
 * createConsoleEmitter() or createMemoryEmitter() instead.
 */

import type { HoplonEmitter, HoplonEvent } from '../emitter.js';

/**
 * Create a no-op emitter that silently drops all events.
 *
 * This is the Phase 1 production default. Zero cost: no validation,
 * no I/O, no side effects.
 */
export function createNoopEmitter(): HoplonEmitter {
  return {
    emit(_event: HoplonEvent): void {
      // intentional no-op
    },
  };
}
