/**
 * adapters/emitter/memory.ts — In-memory emitter for test introspection.
 *
 * Validates each event via HoplonEventSchema.parse before storing. Invalid
 * events throw synchronously at emit time.
 *
 * getEvents() returns a defensive copy so callers cannot mutate the internal
 * store. clear() resets the store between test cases.
 */

import type { HoplonEmitter, HoplonEvent } from '../emitter.js';
import { HoplonEventSchema } from '../emitter.js';

export interface MemoryEmitter extends HoplonEmitter {
  /** Returns a defensive copy of all emitted events in insertion order. */
  getEvents(): HoplonEvent[];
  /** Empties the event store. */
  clear(): void;
}

/**
 * Create an in-memory emitter for test introspection.
 *
 * Validates each event via HoplonEventSchema before storing. Use getEvents()
 * to assert on emitted events and clear() to reset state between test cases.
 */
export function createMemoryEmitter(): MemoryEmitter {
  const store: HoplonEvent[] = [];

  return {
    emit(event: HoplonEvent): void {
      // Validate — throws ZodError on schema violation (including extra fields).
      HoplonEventSchema.parse(event);
      store.push(event);
    },

    getEvents(): HoplonEvent[] {
      return [...store];
    },

    clear(): void {
      store.length = 0;
    },
  };
}
