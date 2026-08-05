/**
 * operations/compressRetryContext.ts — LC9 retry context compression.
 *
 * SYNCHRONOUS — pure data transform over existing AuditViolation arrays.
 * No I/O, no async, no adapters needed. (recs §15.9 + PLAN § Slice LC9)
 *
 * ## Algorithm
 *
 * Given N ordered PriorAttempt records:
 *
 *   1. Collect violation keys from every attempt.
 *   2. persistentViolations — violations whose key appears in EVERY attempt.
 *   3. resolvedViolations   — violations whose key appeared in at least one
 *      earlier attempt but is ABSENT from the latest attempt.
 *   4. newViolations        — violations in the latest attempt whose key
 *      did NOT appear in any earlier attempt.
 *   5. structuralDelta      — human-readable prose summarising 2–4.
 *   6. retryDirective       — single-sentence action directive.
 *
 * ## Violation identity key
 *
 * Two violations are considered "the same" when their kind + path match.
 * For violations that also carry symbolName (out_of_scope_symbol) or
 * parseError (parse_failure), those fields are included to avoid false
 * de-duplication across different symbols in the same file.
 * This is conservative: two violations with the same kind+path but
 * different messages are treated as distinct, which is the safe direction.
 *
 * ## Edge cases
 *
 * - Empty attempts array → empty result with empty delta.
 * - Single attempt → all violations are "new" (no history to compare against).
 * - Identical attempts → all violations persistent, empty resolved/new.
 *
 * ## Import wall
 *
 * Imports only from ../contracts/*. No adapters, no filesystem, no async.
 */

import type { AuditViolation } from '../contracts/audit.js';
import type { PriorAttempt, CompressedRetryContext } from '../contracts/retryContext.js';

// ---------------------------------------------------------------------------
// Violation identity key
// ---------------------------------------------------------------------------

/**
 * Compute a stable identity key for a violation.
 * kind + path are always present; symbolName and parseError are optional
 * discriminators added when available to prevent false merges.
 */
function violationKey(v: AuditViolation): string {
  const base = `${v.kind}::${v.path}`;
  if ('symbolName' in v && v.symbolName) return `${base}::${v.symbolName}`;
  if ('parseError' in v && v.parseError) return `${base}::${v.parseError}`;
  return base;
}

// ---------------------------------------------------------------------------
// compressRetryContext — synchronous pure function
// ---------------------------------------------------------------------------

/**
 * Compress a retry history into a structured delta.
 *
 * SYNCHRONOUS — no Promise, no async. Pure data transform.
 *
 * @param attempts - Ordered list of prior attempts (ascending attemptNumber).
 *                   May be empty; single-element; or multi-element.
 * @returns CompressedRetryContext with categorised violations and prose delta.
 */
export function compressRetryContext(attempts: PriorAttempt[]): CompressedRetryContext {
  const attemptCount = attempts.length;

  // -------------------------------------------------------------------------
  // Empty history — no attempts yet
  // -------------------------------------------------------------------------
  if (attemptCount === 0) {
    return {
      attemptCount: 0,
      structuralDelta: 'No prior attempts.',
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: [],
      retryDirective: 'No prior attempt history available.',
    };
  }

  // -------------------------------------------------------------------------
  // Sort attempts by attemptNumber (caller should already have sorted, but
  // we ensure correctness regardless)
  // -------------------------------------------------------------------------
  const sorted = attempts.slice().sort((a, b) => a.attemptNumber - b.attemptNumber);

  // -------------------------------------------------------------------------
  // Single attempt — all violations are "new" (no earlier history to compare)
  // -------------------------------------------------------------------------
  if (attemptCount === 1) {
    const latest = sorted[0]!;
    const latestViolations = latest.violations;

    const structuralDelta =
      latestViolations.length === 0
        ? `Attempt ${latest.attemptNumber}: no violations.`
        : `Attempt ${latest.attemptNumber}: ${latestViolations.length} violation(s) found.`;

    const retryDirective = buildRetryDirective([], [], latestViolations);

    return {
      attemptCount,
      structuralDelta,
      persistentViolations: [],
      resolvedViolations: [],
      newViolations: latestViolations.slice(),
      retryDirective,
    };
  }

  // -------------------------------------------------------------------------
  // Multi-attempt — compute persistent / resolved / new sets
  // -------------------------------------------------------------------------

  const latest = sorted[sorted.length - 1]!;
  const earlier = sorted.slice(0, sorted.length - 1);

  // Map from violation key → canonical violation object (from first occurrence)
  const allEarlierByKey = new Map<string, AuditViolation>();
  for (const attempt of earlier) {
    for (const v of attempt.violations) {
      const key = violationKey(v);
      if (!allEarlierByKey.has(key)) {
        allEarlierByKey.set(key, v);
      }
    }
  }

  // Key sets per-attempt for persistence check
  const keysByAttempt: Set<string>[] = sorted.map(
    (a) => new Set(a.violations.map(violationKey)),
  );

  // All violation keys that appear in every attempt
  const allKeys = new Set<string>();
  for (const v of sorted[0]!.violations) allKeys.add(violationKey(v));

  const persistentKeys = new Set<string>(
    [...allKeys].filter((k) => keysByAttempt.every((set) => set.has(k))),
  );

  const latestKeySet = new Set(latest.violations.map(violationKey));

  // persistent: present in every attempt
  const persistentViolations: AuditViolation[] = [];
  for (const v of latest.violations) {
    if (persistentKeys.has(violationKey(v))) {
      persistentViolations.push(v);
    }
  }

  // resolved: in some earlier attempt, NOT in latest
  const resolvedViolations: AuditViolation[] = [];
  for (const [key, v] of allEarlierByKey) {
    if (!latestKeySet.has(key)) {
      resolvedViolations.push(v);
    }
  }

  // new: in latest, NOT in any earlier attempt
  const newViolations: AuditViolation[] = [];
  for (const v of latest.violations) {
    if (!allEarlierByKey.has(violationKey(v))) {
      newViolations.push(v);
    }
  }

  // -------------------------------------------------------------------------
  // Build structuralDelta prose
  // -------------------------------------------------------------------------
  const firstAttemptNum = sorted[0]!.attemptNumber;
  const latestAttemptNum = latest.attemptNumber;

  const lines: string[] = [];
  lines.push(
    `Between attempt ${firstAttemptNum} and attempt ${latestAttemptNum} (${attemptCount} total):`,
  );

  if (persistentViolations.length > 0) {
    lines.push(
      `  Persistent (${persistentViolations.length}): ${persistentViolations
        .map((v) => `${v.kind} in ${v.path}`)
        .join(', ')}.`,
    );
  }
  if (resolvedViolations.length > 0) {
    lines.push(
      `  Resolved (${resolvedViolations.length}): ${resolvedViolations
        .map((v) => `${v.kind} in ${v.path}`)
        .join(', ')}.`,
    );
  }
  if (newViolations.length > 0) {
    lines.push(
      `  Newly introduced (${newViolations.length}): ${newViolations
        .map((v) => `${v.kind} in ${v.path}`)
        .join(', ')}.`,
    );
  }
  if (
    persistentViolations.length === 0 &&
    resolvedViolations.length === 0 &&
    newViolations.length === 0
  ) {
    lines.push('  No violations in any attempt — all attempts passed.');
  }

  const structuralDelta = lines.join('\n');
  const retryDirective = buildRetryDirective(
    persistentViolations,
    resolvedViolations,
    newViolations,
  );

  return {
    attemptCount,
    structuralDelta,
    persistentViolations,
    resolvedViolations,
    newViolations,
    retryDirective,
  };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Build a single-sentence retry directive based on the violation categories.
 * Prioritises persistent (never fixed) > new (regression) > resolved (progress).
 */
function buildRetryDirective(
  persistent: AuditViolation[],
  resolved: AuditViolation[],
  added: AuditViolation[],
): string {
  if (persistent.length > 0 && added.length > 0) {
    return (
      `Fix the ${persistent.length} persistent violation(s) in ` +
      `${[...new Set(persistent.map((v) => v.path))].join(', ')} ` +
      `and revert the ${added.length} newly introduced violation(s).`
    );
  }
  if (persistent.length > 0) {
    return (
      `Focus on resolving the ${persistent.length} persistent violation(s) in ` +
      `${[...new Set(persistent.map((v) => v.path))].join(', ')}.`
    );
  }
  if (added.length > 0) {
    return (
      `Revert the ${added.length} newly introduced violation(s) in ` +
      `${[...new Set(added.map((v) => v.path))].join(', ')}.`
    );
  }
  if (resolved.length > 0) {
    return 'Good progress — all prior violations resolved; confirm the latest attempt passes.';
  }
  return 'No violations detected across all attempts; no further retry needed.';
}
