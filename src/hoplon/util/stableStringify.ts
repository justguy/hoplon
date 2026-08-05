/**
 * util/stableStringify.ts — deterministic JSON serialization.
 *
 * Thin wrapper around fast-json-stable-stringify.
 * Key order is always sorted; same value → same string across platforms.
 * Do not add custom logic here — the invariant is the library, not our wrapper.
 *
 * This is the canonical serialization used for content-addressable snapshot IDs
 * (invariant H1: snapshotRef.id = sha256(stableStringify(manifest))).
 */

// fast-json-stable-stringify ships CJS; with NodeNext module resolution we
// use createRequire to import it without violating ESM constraints.
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const fastStringify = require('fast-json-stable-stringify') as (value: unknown) => string;

/**
 * Serialize a value to JSON with keys sorted alphabetically at every level.
 * Arrays preserve element order. Functionally equivalent to
 * `JSON.stringify` for JSON-safe values, but deterministic across key insertion order.
 */
export function stableStringify(value: unknown): string {
  return fastStringify(value);
}
