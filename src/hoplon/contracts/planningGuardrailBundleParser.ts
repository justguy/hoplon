/** contracts/planningGuardrailBundleParser.ts — typed-diagnostic parser for
 * PlanningGuardrailBundle (T-156).
 *
 * Mirrors the `parseFencedContract` shape from T-155: a `safeParse`-style
 * function that returns either a parsed bundle plus its canonical
 * `bundleHash`, or a typed `PlanningGuardrailBundleDiagnostic[]` describing
 * exactly why the input was rejected. Fails closed on hostile inputs by
 * catching property/proxy traps.
 */

import { z } from 'zod';
import {
  DUPLICATE_CLAUSE_ID_PREFIX,
  DUPLICATE_CONFIG_HASH_PREFIX,
  DUPLICATE_RAIL_ID_PREFIX,
  PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS,
  PlanningGuardrailBundleBodySchema,
  hashCanonicalPlanningGuardrailBundleBody,
  stripBundleHash,
  type PlanningGuardrailBundle,
} from './planningGuardrailBundle.js';

export const PLANNING_GUARDRAIL_BUNDLE_DIAGNOSTIC_KINDS = [
  'schema_invalid',
  'unsupported_schema_version',
  'duplicate_clause_id',
  'duplicate_rail_id',
  'duplicate_config_hash',
  'hash_mismatch',
] as const;
export const PlanningGuardrailBundleDiagnosticKindSchema = z.enum(
  PLANNING_GUARDRAIL_BUNDLE_DIAGNOSTIC_KINDS,
);
export type PlanningGuardrailBundleDiagnosticKind = z.infer<
  typeof PlanningGuardrailBundleDiagnosticKindSchema
>;

export const PlanningGuardrailBundleDiagnosticSchema = z.object({
  kind: PlanningGuardrailBundleDiagnosticKindSchema,
  message: z.string().min(1),
  path: z.array(z.union([z.string(), z.number()])).optional(),
  expected: z.string().optional(),
  actual: z.string().optional(),
}).strict();
export type PlanningGuardrailBundleDiagnostic = z.infer<
  typeof PlanningGuardrailBundleDiagnosticSchema
>;

export type ParsedPlanningGuardrailBundle =
  | { ok: true; bundle: PlanningGuardrailBundle; bundleHash: string }
  | { ok: false; diagnostics: PlanningGuardrailBundleDiagnostic[] };

/**
 * Parse a candidate PlanningGuardrailBundle. Recomputes the canonical
 * `bundleHash` and verifies any caller-supplied value against it. Hostile
 * objects (proxy traps, getter throws) surface as a `schema_invalid`
 * diagnostic rather than throwing.
 */
export function parsePlanningGuardrailBundle(
  input: unknown,
): ParsedPlanningGuardrailBundle {
  try {
    return parsePlanningGuardrailBundleUnsafe(input);
  } catch {
    return schemaInvalid(
      'PlanningGuardrailBundle input could not be inspected safely',
    );
  }
}

function parsePlanningGuardrailBundleUnsafe(
  input: unknown,
): ParsedPlanningGuardrailBundle {
  if (hasOwnProperty(input, 'schemaVersion')) {
    const version = readProperty(input, 'schemaVersion');
    if (
      typeof version === 'string'
      && !(PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS as readonly string[]).includes(version)
    ) {
      return {
        ok: false,
        diagnostics: [{
          kind: 'unsupported_schema_version',
          message: `unsupported PlanningGuardrailBundle schemaVersion: ${version}`,
          path: ['schemaVersion'],
          expected: PLANNING_GUARDRAIL_BUNDLE_SCHEMA_VERSIONS.join(','),
          actual: version,
        }],
      };
    }
  }

  const inputHasHash = hasOwnProperty(input, 'bundleHash');
  const bodyParse = PlanningGuardrailBundleBodySchema.safeParse(stripBundleHash(input));
  if (!bodyParse.success) {
    return {
      ok: false,
      diagnostics: bodyParse.error.issues.map(issueToDiagnostic),
    };
  }

  const body = bodyParse.data;
  const bundleHash = hashCanonicalPlanningGuardrailBundleBody(body);

  if (inputHasHash) {
    const supplied = readProperty(input, 'bundleHash');
    if (supplied !== bundleHash) {
      return {
        ok: false,
        diagnostics: [{
          kind: 'hash_mismatch',
          message: 'supplied bundleHash does not match canonical hash of body',
          path: ['bundleHash'],
          expected: bundleHash,
          actual: typeof supplied === 'string' ? supplied : String(supplied),
        }],
      };
    }
  }

  return { ok: true, bundle: { ...body, bundleHash }, bundleHash };
}

function hasOwnProperty(input: unknown, property: string): boolean {
  return !!input
    && typeof input === 'object'
    && Object.prototype.hasOwnProperty.call(input, property);
}

function readProperty(input: unknown, property: string): unknown {
  return (input as Record<string, unknown>)[property];
}

function schemaInvalid(message: string): ParsedPlanningGuardrailBundle {
  return { ok: false, diagnostics: [{ kind: 'schema_invalid', message }] };
}

function issueToDiagnostic(issue: z.ZodIssue): PlanningGuardrailBundleDiagnostic {
  const matchers: ReadonlyArray<{
    prefix: string;
    kind: PlanningGuardrailBundleDiagnostic['kind'];
  }> = [
    { prefix: DUPLICATE_CLAUSE_ID_PREFIX, kind: 'duplicate_clause_id' },
    { prefix: DUPLICATE_RAIL_ID_PREFIX, kind: 'duplicate_rail_id' },
    { prefix: DUPLICATE_CONFIG_HASH_PREFIX, kind: 'duplicate_config_hash' },
  ];
  for (const { prefix, kind } of matchers) {
    if (issue.message.startsWith(prefix)) {
      return {
        kind,
        message: issue.message,
        path: [...issue.path],
        actual: issue.message.slice(prefix.length),
      };
    }
  }
  return { kind: 'schema_invalid', message: issue.message, path: [...issue.path] };
}
