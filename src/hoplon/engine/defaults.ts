/**
 * engine/defaults.ts — shared default engine limits for launcher truth and
 * factory construction.
 */

/** Default per-file size cap for engine read/audit operations. */
export const DEFAULT_MAX_FILE_BYTES = 524288; // 512 KB

/** Default parse timeout applied by engine operations when not overridden. */
export const DEFAULT_PARSE_TIMEOUT_MS = 5000;
