/**
 * operations/validateImports.ts — LC2 import hallucination detection.
 *
 * Pure function wired into dryRun after the scope check.
 * Violations:
 *   IMPORT_TARGET_NOT_FOUND    — relative import path missing from snapshot
 *   IMPORT_SYMBOL_NOT_EXPORTED — target exists but doesn't export the symbol
 *   IMPORT_ALIAS_UNRESOLVED    — tsconfig path alias (e.g. '@/foo') deferred to Phase 3
 *
 * Phase 2 scope: relative imports only. Bare module specifiers skipped.
 * Alias specifiers (@/~) → IMPORT_ALIAS_UNRESOLVED (advisory, not BLOCK).
 * Extension probing: tries specifier as-is then with .ts/.tsx/.js/.jsx/.mjs/.cjs.
 *
 * Import wall: imports only from ../adapters/*, ../contracts/*.
 */

import type { VersioningAdapter } from '../adapters/versioning.js';
import type { CodeIntelligenceAdapter, SyntaxTree } from '../adapters/codeIntelligence.js';
import type { AuditViolation } from '../contracts/audit.js';
import { AdapterError } from '../contracts/errors.js';
import { posix } from 'node:path';

export type ImportCheckStatus = 'PASS' | 'BLOCK' | 'UNCERTAIN';

export interface ImportCheckResult {
  status: ImportCheckStatus;
  violations: AuditViolation[];
}

export interface ValidateImportsDeps {
  versioning: VersioningAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  gitRepoDir: string;
  gitRef: string;
}

interface ParsedImport {
  specifier: string;
  namedSymbols: string[];
}

const PROBE_EXTENSIONS = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs'];

// ---------------------------------------------------------------------------
// validateImports — main entry point
// ---------------------------------------------------------------------------

/**
 * Scan each proposed change for import statements and validate them
 * against the snapshot git tree. Pure — no disk writes, no audit log.
 */
export async function validateImports(
  deps: ValidateImportsDeps,
  changes: ReadonlyArray<{ file: string; content: string }>,
  signal?: AbortSignal,
): Promise<ImportCheckResult> {
  const { versioning, codeIntelligence, gitRepoDir, gitRef } = deps;
  const violations: AuditViolation[] = [];

  for (const change of changes) {
    if (signal?.aborted) break;

    const bytes = Buffer.from(change.content, 'utf8');
    let tree: SyntaxTree;
    try {
      tree = await codeIntelligence.parse(change.file, new Uint8Array(bytes), signal);
    } catch {
      continue; // parse failures handled upstream in dryRun
    }

    for (const imp of _extractImports(tree)) {
      if (signal?.aborted) break;
      const { specifier, namedSymbols } = imp;

      // Alias: starts with '@' or '~' → IMPORT_ALIAS_UNRESOLVED (advisory)
      if (specifier.startsWith('@') || specifier.startsWith('~')) {
        violations.push({
          kind: 'IMPORT_ALIAS_UNRESOLVED',
          path: change.file,
          importPath: specifier,
          note: 'Path alias resolution requires tsconfig — deferred to Phase 3.',
          message: `Import "${specifier}" in ${change.file} uses a path alias that cannot be resolved without tsconfig.`,
          correction: `Use a relative path, or ensure Phase 3 alias resolution is enabled before relying on this import.`,
        });
        continue;
      }

      // Bare module specifiers (e.g. 'react') → skip
      if (!specifier.startsWith('./') && !specifier.startsWith('../')) continue;

      // Resolve target path in the snapshot git tree
      let targetPath: string | null = null;
      let targetBytes: Uint8Array | null = null;

      for (const candidate of _resolveSpecifier(change.file, specifier)) {
        try {
          targetBytes = await versioning.readBlob(gitRepoDir, gitRef, candidate);
          targetPath = candidate;
          break;
        } catch (err) {
          if (err instanceof AdapterError && err.kind === 'git_read_failed') continue;
          throw err;
        }
      }

      if (targetPath === null) {
        violations.push({
          kind: 'IMPORT_TARGET_NOT_FOUND',
          path: change.file,
          importPath: specifier,
          fromFile: change.file,
          message: `Import "${specifier}" in ${change.file} does not exist in the snapshot.`,
          correction: `Create the file at the expected path, or fix the import specifier.`,
        });
        continue;
      }

      // Named import symbol check
      if (namedSymbols.length === 0) continue;

      const availableExports = await _extractExportNames(codeIntelligence, targetPath, targetBytes!, signal);

      for (const sym of namedSymbols) {
        if (!availableExports.includes(sym)) {
          violations.push({
            kind: 'IMPORT_SYMBOL_NOT_EXPORTED',
            path: change.file,
            importPath: specifier,
            symbol: sym,
            availableExports,
            message: `Symbol "${sym}" is not exported by "${targetPath}" in the snapshot.`,
            correction: `Export "${sym}" from "${targetPath}", or remove the import.`,
          });
        }
      }
    }
  }

  if (violations.length === 0) return { status: 'PASS', violations: [] };
  const hasHard = violations.some(
    (v) => v.kind === 'IMPORT_TARGET_NOT_FOUND' || v.kind === 'IMPORT_SYMBOL_NOT_EXPORTED',
  );
  return { status: hasHard ? 'BLOCK' : 'UNCERTAIN', violations };
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type TSNode = { kind: string; namedChildren: unknown[]; text: string };

function _extractImports(tree: SyntaxTree): ParsedImport[] {
  const root = tree.rootNode as unknown as { namedChildren: TSNode[] };
  const results: ParsedImport[] = [];
  for (const child of root.namedChildren) {
    if (child.kind !== 'import_statement') continue;
    const imp = _parseImportStatement(child);
    if (imp !== null) results.push(imp);
  }
  return results;
}

function _parseImportStatement(node: TSNode): ParsedImport | null {
  let specifier: string | null = null;
  const namedSymbols: string[] = [];

  for (const child of node.namedChildren as TSNode[]) {
    if (child.kind === 'string') {
      specifier = child.text.replace(/^['"`]|['"`]$/g, '');
    } else if (child.kind === 'import_clause') {
      for (const c of child.namedChildren as TSNode[]) {
        if (c.kind === 'named_imports') {
          for (const spec of c.namedChildren as TSNode[]) {
            if (spec.kind === 'import_specifier') {
              const nameNode = (spec.namedChildren as TSNode[])[0];
              if (nameNode) namedSymbols.push(nameNode.text);
            }
          }
        }
      }
    }
  }

  return specifier === null ? null : { specifier, namedSymbols };
}

function _resolveSpecifier(importingFile: string, specifier: string): string[] {
  const norm = (p: string): string => p.replace(/\\/g, '/').replace(/^\/+/, '');
  const dir = posix.dirname(importingFile.replace(/\\/g, '/'));
  const base = posix.join(dir, specifier);
  const candidates: string[] = [norm(base)];
  if (!/\.[a-zA-Z0-9]+$/.test(specifier)) {
    for (const ext of PROBE_EXTENSIONS) candidates.push(norm(base + ext));
    for (const ext of PROBE_EXTENSIONS) candidates.push(norm(posix.join(base, 'index' + ext)));
  }
  return candidates;
}

async function _extractExportNames(
  ci: CodeIntelligenceAdapter,
  filePath: string,
  bytes: Uint8Array,
  signal?: AbortSignal,
): Promise<string[]> {
  let tree: SyntaxTree;
  try {
    tree = await ci.parse(filePath, bytes, signal);
  } catch {
    return [];
  }
  return ci.getTopLevelSymbols(tree)
    .filter((s) =>
      s.kind === 'export_statement' || s.kind === 'function_declaration' ||
      s.kind === 'class_declaration' || s.kind === 'lexical_declaration' ||
      s.kind === 'variable_declaration',
    )
    .map((s) => s.name);
}
