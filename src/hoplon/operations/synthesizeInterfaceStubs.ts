/**
 * operations/synthesizeInterfaceStubs.ts — t-028 deterministic interface-stub
 * synthesis over manifest-truth SignatureContracts.
 *
 * ## What this operation is and is not
 * - Advisory only. `result.advisory` is schema-pinned to `true`; no PASS/BLOCK
 *   path (`auditDiff`, `createSnapshot`, `dryRun`, `preflight`) consults the
 *   output. The operation never mutates the manifest, never re-derives
 *   contracts, and never widens structural audit semantics.
 * - A declaration-aware transform over manifest truth. Given already-validated
 *   `signatureContracts` (Zod-parsed at the request boundary) and a list of
 *   caller targets, emits TypeScript declarations via the compiler API
 *   printer: authoritative `export declare function ...;` lines for matched
 *   targets and `export declare const <symbol>: unknown;` placeholders for
 *   the rest. No tree-sitter, no ts-morph dependency addition.
 * - Multiple contracts matching the same `(file, symbol)` (overload-class
 *   input) round-trip as one declaration line per contract in source order.
 *   `contractCount` on the stub echoes the number of feeding contracts.
 *
 * ## Determinism (H7)
 * Stubs are sorted by `(target.file, target.symbol)` with the same collator
 * ('en', sensitivity 'variant'). Same input → byte-identical output.
 *
 * ## Event discipline (H11, H13)
 * - op: 'synthesizeInterfaceStubs'
 * - phases: start / end / error
 * - payload carries counts only (targetCount, authoritativeCount,
 *   placeholderCount). Never a symbol name, type string, path, or declaration
 *   body.
 */

import type { HoplonEmitter } from '../adapters/emitter.js';
import {
  SynthesizeInterfaceStubsRequestSchema,
  SynthesizeInterfaceStubsResultSchema,
  type InterfaceStub,
  type InterfaceStubTarget,
  type SynthesizeInterfaceStubsRequest,
  type SynthesizeInterfaceStubsResult,
  type SynthesizeInterfaceStubsStatus,
} from '../contracts/interfaceStubs.js';
import type { SignatureContract } from '../contracts/manifest.js';
import {
  ValidationError,
  AdapterError,
  EngineError,
  SemanticError,
} from '../contracts/errors.js';
import {
  renderAuthoritativeDeclaration,
  renderPlaceholderDeclaration,
} from './interfaceStubDeclarations.js';
import { validateCorrelationId } from '../util/validators.js';

// ---------------------------------------------------------------------------
// Deps
// ---------------------------------------------------------------------------

export interface SynthesizeInterfaceStubsDeps {
  emitter: HoplonEmitter;
  engineId: string;
}

// ---------------------------------------------------------------------------
// synthesizeInterfaceStubs
// ---------------------------------------------------------------------------

export async function synthesizeInterfaceStubs(
  deps: SynthesizeInterfaceStubsDeps,
  req: SynthesizeInterfaceStubsRequest,
  signal?: AbortSignal,
): Promise<SynthesizeInterfaceStubsResult> {
  const parsed = SynthesizeInterfaceStubsRequestSchema.safeParse(req);
  if (!parsed.success) {
    const corrId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string' &&
      ((req as { correlationId?: string }).correlationId ?? '').length > 0
        ? (req as { correlationId: string }).correlationId
        : 'validator';
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId: deps.engineId,
        correlationId: corrId,
        cause: parsed.error,
      },
      `synthesizeInterfaceStubs: invalid request: ${parsed.error.message}`,
    );
  }
  const request = parsed.data;
  validateCorrelationId(request.correlationId);

  const start = Date.now();
  const emitBase = {
    engineId: deps.engineId,
    correlationId: request.correlationId,
    ...(request.projectId !== undefined ? { projectId: request.projectId } : {}),
  };

  deps.emitter.emit({
    op: 'synthesizeInterfaceStubs',
    phase: 'start',
    ...emitBase,
  });

  try {
    if (signal?.aborted) {
      throw _abortError(signal);
    }

    const contractIndex = _indexContracts(request.signatureContracts ?? []);
    const uniqueTargets = _dedupTargets(request.targets);

    const stubs: InterfaceStub[] = uniqueTargets
      .map((target) =>
        _buildStub(deps.engineId, request.correlationId, target, contractIndex),
      )
      .sort(_compareStubs);

    const authoritativeCount = stubs.reduce(
      (n, s) => n + (s.quality === 'authoritative' ? 1 : 0),
      0,
    );
    const placeholderCount = stubs.length - authoritativeCount;

    const status: SynthesizeInterfaceStubsStatus =
      authoritativeCount === stubs.length
        ? 'AUTHORITATIVE'
        : authoritativeCount === 0
          ? 'PLACEHOLDER_ONLY'
          : 'PARTIAL';

    const result: SynthesizeInterfaceStubsResult = {
      correlationId: request.correlationId,
      advisory: true,
      status,
      stubs,
      authoritativeCount,
      placeholderCount,
    };

    // Re-validate our own output so `advisory: true` cannot silently flip and
    // any count/shape regression is caught at the engine boundary instead of
    // the caller.
    const validated = SynthesizeInterfaceStubsResultSchema.safeParse(result);
    if (!validated.success) {
      throw new ValidationError(
        {
          kind: 'invalid_manifest',
          engineId: deps.engineId,
          correlationId: request.correlationId,
          cause: validated.error,
        },
        `synthesizeInterfaceStubs: produced invalid result: ${validated.error.message}`,
      );
    }

    deps.emitter.emit({
      op: 'synthesizeInterfaceStubs',
      phase: 'end',
      ...emitBase,
      durationMs: Date.now() - start,
      classification: 'PASS',
    });

    return validated.data;
  } catch (err) {
    deps.emitter.emit({
      op: 'synthesizeInterfaceStubs',
      phase: 'error',
      ...emitBase,
      durationMs: Date.now() - start,
      ..._classifyError(err),
    });
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

type ContractIndex = Map<string, SignatureContract[]>;

function _indexKey(file: string, symbol: string): string {
  return `${file}\u0000${symbol}`;
}

function _indexContracts(contracts: readonly SignatureContract[]): ContractIndex {
  const idx: ContractIndex = new Map();
  for (const c of contracts) {
    const key = _indexKey(c.file, c.symbol);
    const bucket = idx.get(key);
    if (bucket !== undefined) {
      bucket.push(c);
    } else {
      idx.set(key, [c]);
    }
  }
  return idx;
}

function _dedupTargets(
  targets: readonly InterfaceStubTarget[],
): InterfaceStubTarget[] {
  const seen = new Set<string>();
  const out: InterfaceStubTarget[] = [];
  for (const t of targets) {
    const key = _indexKey(t.file, t.symbol);
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(t);
  }
  return out;
}

function _buildStub(
  engineId: string,
  correlationId: string,
  target: InterfaceStubTarget,
  index: ContractIndex,
): InterfaceStub {
  const matches = index.get(_indexKey(target.file, target.symbol));
  if (matches === undefined || matches.length === 0) {
    return {
      target,
      quality: 'placeholder',
      declaration: renderPlaceholderDeclaration(
        engineId,
        correlationId,
        target.symbol,
      ),
      reason: 'no_signature_contract',
      contractCount: 0,
    };
  }
  return {
    target,
    quality: 'authoritative',
    declaration: renderAuthoritativeDeclaration(
      engineId,
      correlationId,
      target.symbol,
      matches,
    ),
    reason: null,
    contractCount: matches.length,
  };
}

function _compareStubs(a: InterfaceStub, b: InterfaceStub): number {
  if (a.target.file !== b.target.file) {
    return a.target.file < b.target.file ? -1 : 1;
  }
  if (a.target.symbol !== b.target.symbol) {
    return a.target.symbol < b.target.symbol ? -1 : 1;
  }
  return 0;
}

function _abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}

function _classifyError(
  err: unknown,
): { errorCategory?: 'engine' | 'adapter' | 'semantic' | 'validation'; errorKind?: string } {
  if (err instanceof ValidationError) {
    return { errorCategory: 'validation', errorKind: err.kind };
  }
  if (err instanceof AdapterError) {
    return { errorCategory: 'adapter', errorKind: err.kind };
  }
  if (err instanceof EngineError) {
    return { errorCategory: 'engine', errorKind: err.kind };
  }
  if (err instanceof SemanticError) {
    return { errorCategory: 'semantic', errorKind: err.kind };
  }
  return { errorCategory: 'engine', errorKind: 'synthesize_interface_stubs_failed' };
}
