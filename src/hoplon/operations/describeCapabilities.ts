/**
 * operations/describeCapabilities.ts — capability-introspection operation.
 *
 * Returns the typed extension-capability catalog for T-046. This is a
 * contract/introspection surface only: no registry, no provider execution, and
 * no effect on core PASS/BLOCK semantics.
 */

import type {
  DescribeCapabilitiesRequest,
  DescribeCapabilitiesResult,
} from '../contracts/capabilities.js';
import type { HealthDeps } from './health.js';
import { health as healthOp } from './health.js';
import { buildCapabilityCatalog } from './describeCapabilitiesCatalog.js';

/**
 * t-034 adds two provider-availability booleans that the catalog builder uses
 * to flip `embedding`, `vectorStore`, and the new `semanticSearch` entries from
 * `seam_only` / `noop` to `shipped` / `builtin` when the host supplied real
 * adapters. They are optional so existing call sites that build the deps
 * manually (tests, migrations) keep compiling and default to the seam-only
 * catalog shape they expect.
 */
export interface DescribeCapabilitiesDeps extends HealthDeps {}

export async function describeCapabilities(
  deps: DescribeCapabilitiesDeps,
  req: DescribeCapabilitiesRequest,
  signal?: AbortSignal,
): Promise<DescribeCapabilitiesResult> {
  deps.emitter.emit({
    op: 'describeCapabilities',
    phase: 'start',
    engineId: deps.engineId,
    correlationId: req.correlationId,
  });

  try {
    const health = await healthOp(deps, signal);
    const result: DescribeCapabilitiesResult = {
      catalogVersion: 1,
      engineId: health.engineId,
      capabilities: buildCapabilityCatalog(health, {
        embeddingProvided: deps.embeddingProvided ?? false,
        vectorStoreProvided: deps.vectorStoreProvided ?? false,
        semanticHealth: health.semantic,
      }),
    };

    deps.emitter.emit({
      op: 'describeCapabilities',
      phase: 'end',
      engineId: deps.engineId,
      correlationId: req.correlationId,
      classification: 'PASS',
      durationMs: 0,
    });

    return result;
  } catch (error) {
    const err = error as Error & { kind?: string };
    deps.emitter.emit({
      op: 'describeCapabilities',
      phase: 'error',
      engineId: deps.engineId,
      correlationId: req.correlationId,
      classification: 'ERROR',
      durationMs: 0,
      errorCategory: 'engine',
      errorKind: err.kind ?? err.name ?? 'unknown_error',
    });
    throw error;
  }
}
