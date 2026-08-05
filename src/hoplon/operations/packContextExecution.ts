import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { RefinedSyntaxTree } from '../adapters/codeIntelligence/treeSitter.js';
import type {
  PackedContext,
  PackedSlice,
  PackFailure,
} from '../contracts/context.js';
import type { PackContextRequest } from '../contracts/requests.js';
import {
  abortError,
  buildParseSignal,
  classifyParseError,
} from './packContextErrors.js';
import { applyPackStrategy } from './packContextStrategies.js';

interface ProcessFilesArgs {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  config: { maxFileBytes: number; parseTimeoutMs: number };
  validated: PackContextRequest;
  canonicalPaths: string[];
  signal: AbortSignal | undefined;
}

export async function processPackedFiles(
  args: ProcessFilesArgs,
): Promise<PackedContext> {
  const { fs, codeIntelligence, config, validated, canonicalPaths, signal } = args;
  const pairs = canonicalPaths.map((canonical, index) => ({
    canonical,
    relative: validated.files[index]!,
  }));
  pairs.sort((left, right) =>
    left.relative < right.relative
      ? -1
      : left.relative > right.relative
        ? 1
        : 0,
  );

  const slices: PackedSlice[] = [];
  const failures: PackFailure[] = [];
  let grammarVersion = 'unknown';

  for (const { relative: path } of pairs) {
    if (signal?.aborted) throw abortError(signal);
    const stat = await fs.stat(path);
    if (!stat.exists) {
      failures.push({
        path,
        reason: 'parse_failure',
        parseError: 'file_not_found',
      });
      continue;
    }
    if (stat.size > config.maxFileBytes) {
      failures.push({
        path,
        reason: 'file_too_large',
        sizeBytes: stat.size,
        limitBytes: config.maxFileBytes,
      });
      continue;
    }

    let content: Uint8Array;
    try {
      content = await fs.read(path);
    } catch (error) {
      failures.push({
        path,
        reason: 'parse_failure',
        parseError: error instanceof Error ? error.message : String(error),
      });
      continue;
    }
    if (signal?.aborted) throw abortError(signal);

    let tree: RefinedSyntaxTree;
    try {
      tree = (await codeIntelligence.parse(
        path,
        content,
        buildParseSignal(signal, config.parseTimeoutMs),
      )) as RefinedSyntaxTree;
    } catch (error) {
      const failure = classifyParseError(error, path, config.parseTimeoutMs);
      if (failure !== null) {
        failures.push(failure);
        continue;
      }
      throw error;
    }

    if (grammarVersion === 'unknown' && tree.grammarVersion) {
      grammarVersion = tree.grammarVersion;
    }
    slices.push(
      ...applyPackStrategy(
        path,
        content,
        tree,
        validated.strategy,
        codeIntelligence,
      ),
    );
  }

  slices.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return left.byteRange[0] - right.byteRange[0];
  });
  failures.sort((left, right) => {
    if (left.path < right.path) return -1;
    if (left.path > right.path) return 1;
    return 0;
  });
  return {
    metadata: {
      strategyVersion: 1,
      grammarVersion,
      packerVersion: 1,
      generatedAt: new Date().toISOString(),
      correlationId: validated.correlationId,
    },
    slices,
    failures,
  };
}
