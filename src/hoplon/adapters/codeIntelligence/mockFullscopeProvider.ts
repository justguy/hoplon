/**
 * adapters/codeIntelligence/mockFullscopeProvider.ts — In-memory
 * FullscopeProvider for tests (t-030).
 *
 * Mirrors `mockLspProvider.ts`. Fixture-driven, no subprocess, no MCP
 * transport, no tpf-mcp dependency. Real MCP wiring lives in a separate
 * plugin package.
 *
 * Three fixture modes drive the three seam postures:
 *   - `references[name] = [...]`  → authoritative array (including `[]`)
 *   - `references[name] = undefined` (absent key OR explicit undefined) →
 *     "not available"; adapter falls through to fallback
 *   - `unavailable: true` → provider throws the explicit unavailable error
 *     posture the adapter recognizes and falls through on
 */

import {
  FullscopeProviderUnavailableError,
  type FullscopeProvider,
  type FullscopeReference,
} from './fullscope.js';

/**
 * Fixture data for `findReferences`.
 *
 * Keys are symbol names. A value of `undefined` (or an absent key) signals
 * "not available"; an array (including `[]`) is authoritative.
 */
export type FullscopeReferenceFixtures = Record<
  string,
  FullscopeReference[] | undefined
>;

export interface MockFullscopeProviderOptions {
  /**
   * Reference lists keyed by symbol name. Present keys are authoritative
   * (including `[]`). Absent keys resolve to `undefined` from the mock.
   */
  references?: FullscopeReferenceFixtures;

  /**
   * When `true`, every provider call throws a synthetic "provider unavailable"
   * error. Used to prove the adapter's error-to-fallback path.
   */
  unavailable?: boolean;
}

export function createMockFullscopeProvider(
  options: MockFullscopeProviderOptions = {},
): FullscopeProvider {
  const { references = {}, unavailable = false } = options;

  async function findReferences(
    _file: string,
    symbol: string,
  ): Promise<FullscopeReference[] | undefined> {
    if (unavailable) {
      throw new FullscopeProviderUnavailableError(
        'mock fullscope provider: unavailable',
      );
    }
    if (Object.prototype.hasOwnProperty.call(references, symbol)) {
      return references[symbol];
    }
    return undefined;
  }

  return { findReferences };
}
