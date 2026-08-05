/**
 * engine/grammarsDir.ts — robust resolution + validation of the tree-sitter
 * grammars directory (F1).
 *
 * The tree-sitter CodeIntelligence adapter loads its runtime and language
 * grammars from a `vendor/grammars` directory. Two defaulting bugs used to
 * point that directory at a location that normally does not exist:
 *   - registered external projects defaulted to `<project>/vendor/grammars`
 *   - the public default factory defaulted to a working-directory-relative
 *     `vendor/grammars`
 * Either way the missing directory only surfaced as a deferred parser-init
 * failure deep inside the engine.
 *
 * This module resolves the grammars directory relative to the INSTALLED hoplon
 * package (the location of this module on disk), never the working directory or
 * the target project, and validates its presence up front with a typed,
 * actionable error.
 *
 * Pure asset location only — it never touches project files, never starts an
 * engine, and never mutates state.
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import { EngineError } from '../contracts/errors.js';

const GRAMMARS_RELATIVE = 'vendor/grammars';
/** Runtime wasm that must be present for a directory to be a real grammars dir. */
const RUNTIME_WASM = 'tree-sitter.wasm';

/** True when `candidate` is a directory that actually contains the runtime wasm. */
function isPopulatedGrammarsDir(candidate: string): boolean {
  try {
    if (!fs.statSync(candidate).isDirectory()) return false;
    return fs.existsSync(path.join(candidate, RUNTIME_WASM));
  } catch {
    return false;
  }
}

/**
 * Locate the `vendor/grammars` directory bundled with the installed hoplon
 * package by walking upward from this module's own location. Returns the
 * absolute path of the first populated `vendor/grammars` found, or `null` when
 * none can be located (e.g. a build that never ran `node scripts/fetch-grammars.js`).
 *
 * Resolution is anchored to this module — NOT `process.cwd()` and NOT any
 * project root — so it is stable regardless of where the process was started.
 */
export function resolvePackagedGrammarsDir(): string | null {
  const here = fileURLToPath(import.meta.url);
  let dir = path.dirname(here);
  const visited = new Set<string>();
  while (!visited.has(dir)) {
    visited.add(dir);
    const candidate = path.join(dir, GRAMMARS_RELATIVE);
    if (isPopulatedGrammarsDir(candidate)) return candidate;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return null;
}

/**
 * Assert that `grammarsDir` points at a populated grammars directory. Narrows
 * `string | null` to `string` on success.
 *
 * Throws EngineError({ kind: 'grammars_dir_missing' }) — naming the missing
 * path and how to fix it — instead of letting a deferred parser-init failure
 * surface deep inside the engine.
 */
export function assertGrammarsDirPresent(
  grammarsDir: string | null,
  ctx: { engineId: string; correlationId: string },
): asserts grammarsDir is string {
  if (grammarsDir !== null && isPopulatedGrammarsDir(grammarsDir)) return;
  const shown = grammarsDir ?? '(no packaged grammars directory could be located)';
  throw new EngineError(
    {
      kind: 'grammars_dir_missing',
      engineId: ctx.engineId,
      correlationId: ctx.correlationId,
    },
    `tree-sitter grammars directory is missing or incomplete at '${shown}'. ` +
      `Expected a directory containing '${RUNTIME_WASM}' plus the per-language grammar .wasm files. ` +
      `Populate it by running 'node scripts/fetch-grammars.js', or pass an explicit grammarsDir ` +
      `pointing at your packaged grammars location.`,
  );
}
