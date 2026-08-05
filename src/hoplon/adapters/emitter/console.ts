/**
 * adapters/emitter/console.ts — Structured JSON emitter for dev/debug.
 *
 * Validates each event via HoplonEventSchema.parse before writing. A malformed
 * event (including one that violates H13 with extra fields) throws at emit
 * time — Zod .strict() catches it. This is intentional: console emitter is
 * used in tests and development where surfacing schema violations early is
 * desirable.
 *
 * Writes one JSON line per event to the provided stream (default: stderr).
 */

import type { HoplonEmitter, HoplonEvent } from '../emitter.js';
import { HoplonEventSchema } from '../emitter.js';

export interface ConsoleEmitterOptions {
  /** Destination stream. Defaults to process.stderr. */
  stream?: NodeJS.WritableStream;
}

/**
 * Create a console emitter that writes structured JSON events to a stream.
 *
 * Validates each event via HoplonEventSchema before writing. Invalid events
 * (including H13 violations caught by .strict()) throw synchronously at emit
 * time, making schema violations immediately visible in test and debug runs.
 */
export function createConsoleEmitter(options: ConsoleEmitterOptions = {}): HoplonEmitter {
  const stream = options.stream ?? process.stderr;

  return {
    emit(event: HoplonEvent): void {
      // Validate — throws ZodError on schema violation (including extra fields).
      // This ensures H13 is enforced at the emitter boundary in dev/test.
      HoplonEventSchema.parse(event);
      stream.write(JSON.stringify(event) + '\n');
    },
  };
}
