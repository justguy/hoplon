/**
 * launcher/projectsSecretSchema.ts — parse helper for the persisted
 * `policy.secretPatterns` field.
 *
 * Extracted from `projectsStoreSchema.ts` so that file stays under the
 * 300-line architecture cap once the t-082 folder-policy schema is
 * wired in. Behavior is identical to the previous in-file helper —
 * input shape `{ source: string, flags: string }[]`, output shape
 * `RegExp[]`, structured `ProjectsSchemaError` on any rejection.
 */

import { ProjectsSchemaError } from './projectsStoreSchema.js';

export function parseSecretPatterns(
  raw: unknown,
  idx: number,
  filePath: string,
): RegExp[] {
  if (!Array.isArray(raw)) {
    throw new ProjectsSchemaError(
      'invalid_schema',
      filePath,
      `projects[${idx}].policy.secretPatterns must be an array`,
    );
  }
  const patterns: RegExp[] = [];
  for (let i = 0; i < raw.length; i++) {
    const p = raw[i] as unknown;
    if (
      p === null ||
      typeof p !== 'object' ||
      typeof (p as Record<string, unknown>)['source'] !== 'string' ||
      typeof (p as Record<string, unknown>)['flags'] !== 'string'
    ) {
      throw new ProjectsSchemaError(
        'invalid_schema',
        filePath,
        `projects[${idx}].policy.secretPatterns[${i}] must be { source: string, flags: string }`,
      );
    }
    try {
      patterns.push(
        new RegExp(
          (p as Record<string, string>)['source']!,
          (p as Record<string, string>)['flags']!,
        ),
      );
    } catch (err) {
      throw new ProjectsSchemaError(
        'invalid_schema',
        filePath,
        `projects[${idx}].policy.secretPatterns[${i}] is not a valid regex: ${
          err instanceof Error ? err.message : String(err)
        }`,
        err,
      );
    }
  }
  return patterns;
}
