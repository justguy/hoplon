/** Adapter normalization and validation phase for createHoplonEngine. */

import { EngineError, ValidationError } from '../contracts/errors.js';
import type { HoplonAdapters, HoplonEngineConfig } from './types.js';
import { DEFAULT_ENGINE_ID } from './factoryConstants.js';

const MANDATORY_ADAPTER_KEYS = [
  'fs',
  'versioning',
  'snapshotStore',
  'lockProvider',
  'emitter',
  'codeIntelligence',
  'secretScanner',
] as const;

export function resolveFactoryAdapters(
  adapters: HoplonAdapters,
  config?: HoplonEngineConfig,
) {
  // Step 1: Resolve engineId + validate (ALIGN-4, H18)
  //
  // engineId moved from HoplonAdapters to HoplonEngineConfig in A3.1. Both
  // locations are accepted for backward-compat; the factory applies:
  //   - config.engineId only → normal path (canonical, no warning).
  //   - adapters.engineId only → deprecated path; deprecation event emitted after
  //     mandatory-adapter validation (emitter guaranteed present by then), then
  //     copied into effective engineId.
  //   - Both present and identical → no warning; proceed (idempotent duplicate).
  //   - Both present and different → ValidationError (conflicting_adapters).
  //   - Neither present → DEFAULT_ENGINE_ID ('local-0').
  // -------------------------------------------------------------------------
  const configEngineId = config?.engineId;
  const adaptersEngineId = adapters.engineId;

  const hasConfigEngineId = configEngineId !== undefined && configEngineId !== null;
  const hasAdaptersEngineId = adaptersEngineId !== undefined && adaptersEngineId !== null;

  // Conflict: both set and different → hard reject
  if (hasConfigEngineId && hasAdaptersEngineId && configEngineId !== adaptersEngineId) {
    throw new ValidationError(
      {
        kind: 'conflicting_adapters',
        engineId: configEngineId ?? DEFAULT_ENGINE_ID,
        correlationId: 'factory',
      },
      "Both 'config.engineId' and 'adapters.engineId' (deprecated) were provided with " +
        "different values. Remove 'adapters.engineId' and set 'config.engineId' only.",
    );
  }

  // Track whether adapters.engineId was the sole source (for deprecation event later)
  const adaptersEngineIdUsed = hasAdaptersEngineId && !hasConfigEngineId;

  const candidateId = configEngineId ?? adaptersEngineId ?? DEFAULT_ENGINE_ID;

  // Validate engineId: non-empty, printable ASCII, no whitespace
  if (!candidateId || /\s/.test(candidateId) || !/^[\x20-\x7E]+$/.test(candidateId)) {
    throw new EngineError(
      {
        kind: 'config_invalid',
        engineId: DEFAULT_ENGINE_ID,
        correlationId: 'factory',
      },
      `engineId must be a non-empty printable ASCII string with no whitespace. Got: '${candidateId}'`,
    );
  }

  // Freeze engineId into a closure constant (H5)
  const engineId: string = candidateId;

  // -------------------------------------------------------------------------
  // Step 1.5: Resolve gitAdapter deprecated alias (ALIGN-2, H18)
  //
  // Rules (enforced before mandatory-adapter validation):
  //   - Both versioning + gitAdapter provided → ValidationError (conflicting_adapters).
  //   - gitAdapter only (no versioning) → normalize: resolved.versioning = gitAdapter;
  //     a deprecation warning is emitted after the emitter is confirmed present.
  //   - versioning only → no-op (normal path).
  // -------------------------------------------------------------------------
  const hasVersioning =
    adapters.versioning !== undefined && adapters.versioning !== null;
  const hasGitAdapter =
    adapters.gitAdapter !== undefined && adapters.gitAdapter !== null;

  if (hasVersioning && hasGitAdapter) {
    throw new ValidationError(
      {
        kind: 'conflicting_adapters',
        engineId,
        correlationId: 'factory',
      },
      "Both 'versioning' and 'gitAdapter' were provided. " +
        "Remove 'gitAdapter' (deprecated alias) and keep 'versioning'.",
    );
  }

  // Build a normalized adapters object so the rest of the factory always sees `versioning`.
  // If gitAdapter was the sole versioning source, we track that for the deprecation event.
  const gitAdapterAliasUsed = !hasVersioning && hasGitAdapter;
  const resolvedAdapters: HoplonAdapters = gitAdapterAliasUsed
    ? { ...adapters, versioning: adapters.gitAdapter! }
    : adapters;

  // -------------------------------------------------------------------------
  // Step 2: Validate all 7 mandatory adapters (uses resolvedAdapters so that
  // gitAdapter-only callers see 'versioning' present after normalization).
  // -------------------------------------------------------------------------
  for (const key of MANDATORY_ADAPTER_KEYS) {
    if (resolvedAdapters[key] === undefined || resolvedAdapters[key] === null) {
      throw new EngineError(
        {
          kind: 'missing_adapter',
          engineId,
          correlationId: 'factory',
          cause: { adapter: key },
        },
        `Required adapter '${key}' is missing or undefined.`,
      );
    }
  }

  // -------------------------------------------------------------------------
  // Step 2.5: Emit deprecation warning for gitAdapter alias (ALIGN-2, H13, H18)
  //
  // Emitted after mandatory-adapter validation so that `emitter` is guaranteed
  // to be present. Structure-only per H13: no adapter values, paths, or content.
  // -------------------------------------------------------------------------
  if (gitAdapterAliasUsed) {
    resolvedAdapters.emitter.emit({
      op: 'factory',
      phase: 'error',
      engineId,
      correlationId: 'factory',
      errorCategory: 'validation',
      errorKind: 'deprecated_adapter_gitAdapter',
    });
  }

  // -------------------------------------------------------------------------
  // Step 2.6: Emit deprecation warning for adapters.engineId (ALIGN-4, H13, H18)
  //
  // engineId moved to HoplonEngineConfig in A3.1. If the caller still passes it
  // on HoplonAdapters, emit a structured, content-free deprecation event.
  // Emitted after mandatory-adapter validation (emitter guaranteed present).
  // Structure-only per H13: no adapter values, paths, or content.
  // -------------------------------------------------------------------------
  if (adaptersEngineIdUsed) {
    resolvedAdapters.emitter.emit({
      op: 'factory',
      phase: 'error',
      engineId,
      correlationId: 'factory',
      errorCategory: 'validation',
      errorKind: 'deprecated_adapter_engineId',
    });
  }

  // -------------------------------------------------------------------------

  return { engineId, resolvedAdapters };
}

export type ResolvedFactoryAdapters = ReturnType<
  typeof resolveFactoryAdapters
>;
