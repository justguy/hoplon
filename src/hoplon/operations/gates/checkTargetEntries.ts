import type { PreflightGateContext } from '../preflight.js';
import type { AuditViolation } from '../../contracts/audit.js';
import type { ManifestEntry } from '../../contracts/manifest.js';
import { AdapterError } from '../../contracts/errors.js';

export async function checkFileTarget(
  entry: ManifestEntry,
  gitRef: string,
  gitRepoDir: string,
  ctx: PreflightGateContext,
  violations: AuditViolation[],
): Promise<void> {
  let fileExists = false;
  try {
    await ctx.versioning.readBlob(gitRepoDir, gitRef, entry.path);
    fileExists = true;
  } catch (err) {
    if (err instanceof AdapterError && err.kind === 'git_read_failed') {
      fileExists = false;
    } else {
      throw err;
    }
  }

  if (entry.intent === 'modify' && !fileExists) {
    violations.push({
      kind: 'TARGET_NOT_FOUND',
      path: entry.path,
      symbolName: entry.path,
      manifestIntent: 'modify',
      message: `File "${entry.path}" does not exist in snapshot; cannot modify.`,
      correction: `Check the path spelling, or change intent to 'create' if the file should be created.`,
    });
  } else if (entry.intent === 'create' && fileExists) {
    let byteRange: [number, number] = [0, 0];
    try {
      const bytes = await ctx.versioning.readBlob(gitRepoDir, gitRef, entry.path);
      byteRange = [0, bytes.byteLength];
    } catch {
      // Preserve the existing best-effort fallback when the second read fails.
    }
    violations.push({
      kind: 'DUPLICATE_TARGET',
      path: entry.path,
      symbolName: entry.path,
      manifestIntent: 'create',
      existingByteRange: byteRange,
      message: `File "${entry.path}" already exists in snapshot; cannot create.`,
      correction: `Use intent:'modify' if updating the existing file, or choose a unique path.`,
    });
  }
}

export async function checkSymbolTargets(
  entry: ManifestEntry,
  gitRef: string,
  gitRepoDir: string,
  ctx: PreflightGateContext,
  violations: AuditViolation[],
  signal?: AbortSignal,
): Promise<void> {
  if (entry.scope.kind !== 'symbols') return;
  let blob: Uint8Array;
  let fileExists = true;
  try {
    blob = await ctx.versioning.readBlob(gitRepoDir, gitRef, entry.path);
  } catch (err) {
    if (err instanceof AdapterError && err.kind === 'git_read_failed') {
      fileExists = false;
      blob = new Uint8Array(0);
    } else {
      throw err;
    }
  }

  if (!fileExists) {
    if (entry.intent === 'modify') {
      for (const symbolName of entry.scope.symbols) {
        violations.push({
          kind: 'TARGET_NOT_FOUND',
          path: entry.path,
          symbolName,
          manifestIntent: 'modify',
          message: `File "${entry.path}" does not exist in snapshot; symbol "${symbolName}" cannot be found.`,
          correction: `Check the path spelling, or change intent to 'create' if the file and symbol should be created.`,
        });
      }
    }
    return;
  }

  const tree = await ctx.codeIntelligence.parse(entry.path, blob, signal);
  const symbols = ctx.codeIntelligence.getTopLevelSymbols(tree);
  for (const symbolName of entry.scope.symbols) {
    const found = symbols.find((symbol) => symbol.name === symbolName);
    if (entry.intent === 'modify' && !found) {
      violations.push({
        kind: 'TARGET_NOT_FOUND',
        path: entry.path,
        symbolName,
        manifestIntent: 'modify',
        message: `Symbol "${symbolName}" does not exist in "${entry.path}" at snapshot.`,
        correction: `Check the spelling or change intent to 'create' if adding a new symbol.`,
      });
    } else if (entry.intent === 'create' && found) {
      violations.push({
        kind: 'DUPLICATE_TARGET',
        path: entry.path,
        symbolName,
        manifestIntent: 'create',
        existingByteRange: found.byteRange,
        message: `Symbol "${symbolName}" already exists in "${entry.path}".`,
        correction: `Use intent:'modify' if updating the existing symbol, or choose a unique name.`,
      });
    }
  }
}
