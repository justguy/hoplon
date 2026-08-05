/**
 * adapters/emitter/assert.ts — H13 content-free runtime assertion helper.
 *
 * assertEventIsContentFree is a belt-and-suspenders check beyond Zod's
 * .strict(). Zod's .strict() catches unknown field *names* at the schema
 * level; this helper catches sloppy field *values* that pass the schema but
 * leak content (long strings, code fragments) and catches any object that
 * still carries known-forbidden field names (e.g. through type assertion
 * bypasses at call sites).
 *
 * Use in tests to prove H13 on any event that reaches the emitter boundary.
 */

import { ValidationError } from '../../contracts/errors.js';
import { HoplonEventSchema } from '../emitter.js';
import type { HoplonEvent } from '../emitter.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum string length before a value is considered content. */
const MAX_VALUE_LENGTH = 256;

/** Substring patterns that indicate code content leakage. */
const CODE_SUBSTRINGS: readonly string[] = [
  'function',
  'class',
  'const ',
  'import ',
  '//',
  '/*',
];

/** Field names that are unconditionally forbidden, regardless of value. */
const FORBIDDEN_FIELD_NAMES: readonly string[] = [
  'symbolName',
  'sourceSlice',
  'content',
  'code',
  'text',
  'body',
  'manifest',
  'files',
  'paths',
];

// ---------------------------------------------------------------------------
// Recursive value walker
// ---------------------------------------------------------------------------

/**
 * Walk all string values (and object keys) in `value` recursively.
 * Calls onValue for every string value encountered.
 * Calls onKey for every object key encountered.
 */
function walkObject(
  value: unknown,
  onKey: (key: string) => void,
  onValue: (str: string, path: string) => void,
  path = 'event',
): void {
  if (typeof value === 'string') {
    onValue(value, path);
    return;
  }
  if (Array.isArray(value)) {
    for (let i = 0; i < value.length; i++) {
      walkObject(value[i], onKey, onValue, `${path}[${i}]`);
    }
    return;
  }
  if (value !== null && typeof value === 'object') {
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      onKey(k);
      walkObject(v, onKey, onValue, `${path}.${k}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Assertion
// ---------------------------------------------------------------------------

/**
 * Assert that `event` satisfies HoplonEvent AND contains no content leakage.
 *
 * Checks (layered):
 *   1. Zod schema parse — catches structural violations + .strict() unknown fields
 *   2. Forbidden field names — catches known content-bearing names even when
 *      values are empty (any presence is a violation)
 *   3. Value length — any string value > 256 chars is considered content
 *   4. Code substrings — field values containing code fragments are blocked
 *
 * @throws {ValidationError} with kind 'invalid_scope' on any violation.
 */
export function assertEventIsContentFree(
  event: unknown,
): asserts event is HoplonEvent {
  // Layer 1: Zod schema validation (catches extra fields via .strict())
  const result = HoplonEventSchema.safeParse(event);
  if (!result.success) {
    throw new ValidationError(
      {
        kind: 'invalid_scope',
        engineId: 'assertEventIsContentFree',
        correlationId: extractCorrelationId(event),
        cause: result.error,
      },
      `H13 violation — event failed schema validation: ${result.error.message}`,
    );
  }

  // Layer 2 & 3 & 4: walk the parsed (safe) event for value/key violations
  walkObject(
    result.data,
    (key) => {
      if (FORBIDDEN_FIELD_NAMES.includes(key)) {
        throw new ValidationError(
          {
            kind: 'invalid_scope',
            engineId: 'assertEventIsContentFree',
            correlationId: result.data.correlationId,
          },
          `H13 violation — event contains forbidden field name: "${key}"`,
        );
      }
    },
    (str, path) => {
      if (str.length > MAX_VALUE_LENGTH) {
        throw new ValidationError(
          {
            kind: 'invalid_scope',
            engineId: 'assertEventIsContentFree',
            correlationId: result.data.correlationId,
          },
          `H13 violation — field value at ${path} exceeds ${MAX_VALUE_LENGTH} characters (length: ${str.length})`,
        );
      }
      for (const sub of CODE_SUBSTRINGS) {
        if (str.includes(sub)) {
          throw new ValidationError(
            {
              kind: 'invalid_scope',
              engineId: 'assertEventIsContentFree',
              correlationId: result.data.correlationId,
            },
            `H13 violation — field value at ${path} contains code-like substring: "${sub}"`,
          );
        }
      }
    },
  );
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function extractCorrelationId(event: unknown): string {
  if (
    event !== null &&
    typeof event === 'object' &&
    'correlationId' in (event as object) &&
    typeof (event as Record<string, unknown>)['correlationId'] === 'string'
  ) {
    return (event as Record<string, unknown>)['correlationId'] as string;
  }
  return 'unknown';
}
