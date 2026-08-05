import type {
  CodeIntelligenceAdapterLike,
  HoplonSyntaxTree,
  HoplonSymbol,
} from './hoplonSeam.js';
import type { ScipProvider } from './types.js';

export interface ScipCodeIntelligenceOptions {
  provider: ScipProvider;
  fallbackAdapter?: CodeIntelligenceAdapterLike;
}

const SENTINEL_ENGINE_ID = 'adapter';
const SENTINEL_CORR_ID = 'adapter-scip';

/**
 * Create a CodeIntelligenceAdapter backed by an offline SCIP-style provider.
 *
 * Scope on this branch:
 * - parse/getTopLevelSymbols still delegate to the fallback adapter because the
 *   offline index is Layer 2 reference metadata, not a parser replacement
 * - findReferences/findDependencies are answered by the offline provider
 * - missing/stale index state is surfaced explicitly via provider errors rather
 *   than silently downgraded into fallback cross-file answers
 * - this branch consumes a deterministic JSON snapshot projection rather than a
 *   raw `.scip` protobuf artifact
 */
export function createScipCodeIntelligence(
  options: ScipCodeIntelligenceOptions,
): CodeIntelligenceAdapterLike {
  const { provider, fallbackAdapter } = options;

  async function parse(
    file: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<HoplonSyntaxTree> {
    if (!fallbackAdapter) {
      throw new Error(
        `[${SENTINEL_ENGINE_ID}:${SENTINEL_CORR_ID}] createScipCodeIntelligence: ` +
          `parse() requires a fallbackAdapter (no fallback provided). ` +
          `Supply a tree-sitter adapter via the fallbackAdapter option.`,
      );
    }
    return fallbackAdapter.parse(file, content, signal);
  }

  function getTopLevelSymbols(tree: HoplonSyntaxTree): HoplonSymbol[] {
    if (!fallbackAdapter) {
      throw new Error(
        `[${SENTINEL_ENGINE_ID}:${SENTINEL_CORR_ID}] createScipCodeIntelligence: ` +
          `getTopLevelSymbols() requires a fallbackAdapter (no fallback provided). ` +
          `Supply a tree-sitter adapter via the fallbackAdapter option.`,
      );
    }
    return fallbackAdapter.getTopLevelSymbols(tree);
  }

  async function findReferences(symbol: HoplonSymbol) {
    return provider.findReferences('', symbol.name);
  }

  async function findDependencies(file: string) {
    return provider.findDependencies(file);
  }

  return {
    parse,
    getTopLevelSymbols,
    findReferences,
    findDependencies,
  };
}
