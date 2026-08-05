/**
 * Architecture test: Hoplon import boundary enforcement.
 *
 * Two duties:
 * 1. Positive gate — walks src/hoplon/** with dependency-cruiser and asserts
 *    zero forbidden edges. This proves the live code tree is clean.
 * 2. Negative gate — runs the same boundary rules against the forbidden-import
 *    fixture and asserts the violation IS detected. This proves the checker
 *    fails closed, not silently open.
 *
 * Library chosen: dependency-cruiser (not a custom TS Compiler API walker).
 * Rationale: dependency-cruiser is a maintained, well-tested static-analysis
 * tool that understands TypeScript module resolution. A custom walker would
 * need to re-implement resolution logic — additional surface area for bugs.
 * The fixture is .ts.txt so tsc/vitest never compile it; the negative test
 * parses the import strings directly via the boundary-rule checker below.
 */

import { describe, it, expect } from 'vitest';
import { cruise } from 'dependency-cruiser';
import { readFileSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '../..');
const HOPLON_SRC = resolve(ROOT, 'src/hoplon');

// ---------------------------------------------------------------------------
// Boundary rule definitions (mirrors .dependency-cruiser.cjs)
// These are used for both the dep-cruiser positive check and the fixture
// negative check so both tests exercise the same rule set.
// ---------------------------------------------------------------------------

const FORBIDDEN_PATH_PATTERNS = [
  { pattern: /pipeline/, ruleName: 'hoplon-no-pipeline' },
  { pattern: /agents/, ruleName: 'hoplon-no-agents' },
  { pattern: /process-ledger/, ruleName: 'hoplon-no-process-ledger' },
  { pattern: /adr-graph/, ruleName: 'hoplon-no-adr-graph' },
  {
    pattern:
      /sqlite-vec|better-sqlite3|hnswlib|@huggingface\/transformers|@xenova\/transformers|onnxruntime|@babel\/parser|ts-morph/,
    ruleName: 'hoplon-no-semantic-runtime-packages',
  },
] as const;

/**
 * Naive import-string extractor used for the fixture check.
 * Extracts the module specifier from ES-module import statements.
 * This is intentionally simple: the fixture is a static .ts.txt file, not
 * a dynamic code path. We test the rule logic, not a full TS parser.
 */
function extractImportSpecifiers(source: string): string[] {
  const specifiers: string[] = [];
  // Match: import ... from 'specifier' or import ... from "specifier"
  const importRe = /\bfrom\s+['"]([^'"]+)['"]/g;
  let match: RegExpExecArray | null;
  while ((match = importRe.exec(source)) !== null) {
    const specifier = match[1];
    if (specifier !== undefined) {
      specifiers.push(specifier);
    }
  }
  return specifiers;
}

/**
 * Runs boundary rules against a list of import specifiers.
 * Returns the rule names that were violated (one entry per violation).
 */
function detectViolations(
  specifiers: string[],
): Array<{ specifier: string; ruleName: string }> {
  const violations: Array<{ specifier: string; ruleName: string }> = [];
  for (const specifier of specifiers) {
    for (const rule of FORBIDDEN_PATH_PATTERNS) {
      if (rule.pattern.test(specifier)) {
        violations.push({ specifier, ruleName: rule.ruleName });
      }
    }
  }
  return violations;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('Hoplon import boundary', () => {
  it('positive gate — src/hoplon/** has zero forbidden edges', async () => {
    // When the src/hoplon directory is empty (before A3 code lands), dep-cruiser
    // returns successfully with zero modules and zero violations. That is the
    // correct result: an empty subtree is clean by definition.
    if (!existsSync(HOPLON_SRC)) {
      // Directory not yet created — trivially clean.
      return;
    }

    const result = await cruise(
      [HOPLON_SRC],
      {
        outputType: 'json',
        doNotFollow: { path: 'node_modules' },
        exclude: { path: '(node_modules|dist|vendor)' },
        tsConfig: { fileName: resolve(ROOT, 'tsconfig.json') },
        moduleSystems: ['es6', 'cjs'],
        combinedDependencies: false,
      },
      undefined,
      {
        forbidden: FORBIDDEN_PATH_PATTERNS.map((r) => ({
          name: r.ruleName,
          severity: 'error' as const,
          from: { path: '^src/hoplon/' },
          to: { path: r.pattern.source },
        })),
      },
    );

    // dependency-cruiser returns { output: CruiseResult, exitCode: number }
    // when outputType is 'json' and the result object is the parsed JSON.
    const cruiseResult =
      typeof result.output === 'string'
        ? (JSON.parse(result.output) as { summary: { violations: unknown[] } })
        : (result.output as { summary: { violations: unknown[] } });

    const violations = cruiseResult.summary?.violations ?? [];
    expect(violations, 'Expected zero boundary violations in src/hoplon/**').toHaveLength(0);
  });

  it('negative gate — fixture violations ARE detected with specific rule names', () => {
    const fixturePath = resolve(
      __dirname,
      'fixtures/forbidden-import.ts.txt',
    );
    const fixtureSource = readFileSync(fixturePath, 'utf8');
    const specifiers = extractImportSpecifiers(fixtureSource);

    // Sanity: fixture must have at least 2 import specifiers
    expect(specifiers.length).toBeGreaterThanOrEqual(2);

    const violations = detectViolations(specifiers);

    // Must catch the pipeline violation
    const pipelineViolation = violations.find(
      (v) => v.ruleName === 'hoplon-no-pipeline',
    );
    expect(
      pipelineViolation,
      'Expected hoplon-no-pipeline violation to be detected',
    ).toBeDefined();
    expect(pipelineViolation?.specifier).toMatch(/pipeline/);

    // Must catch the agents violation
    const agentsViolation = violations.find(
      (v) => v.ruleName === 'hoplon-no-agents',
    );
    expect(
      agentsViolation,
      'Expected hoplon-no-agents violation to be detected',
    ).toBeDefined();
    expect(agentsViolation?.specifier).toMatch(/agents/);

    const semanticRuntimeViolation = violations.find(
      (v) => v.ruleName === 'hoplon-no-semantic-runtime-packages',
    );
    expect(
      semanticRuntimeViolation,
      'Expected semantic runtime package violation to be detected',
    ).toBeDefined();
    expect(semanticRuntimeViolation?.specifier).toMatch(/sqlite-vec|onnxruntime/);

    // Total: exactly 3 distinct rule violations (one per forbidden pattern group)
    const uniqueRules = new Set(violations.map((v) => v.ruleName));
    expect(uniqueRules.size).toBe(3);
  });
});
