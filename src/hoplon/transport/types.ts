/**
 * transport/types.ts — Transport-layer contracts for Phase 3.
 *
 * H24 invariant: every wire-crossed DTO roundtrips through its Zod schema;
 * transport layer is stateless.
 *
 * This file is pure contract + helper code. No actual transport implementation
 * lives here — HTTP server (T1) and client (T2) are Wave 2 slices.
 *
 * Design:
 * - `HoplonEngineTransport` abstracts the wire protocol (HTTP / gRPC / in-process).
 *   Wave 2 binds concrete implementations; tests inject stubs.
 * - `serializeRequest` / `deserializeResponse` are the only points where DTOs
 *   cross the wire boundary. Both validate through the caller-supplied Zod schema
 *   so any schema drift is caught at the boundary, not in business logic.
 * - `TransportError` extends `HoplonError` with caller-response semantics
 *   "escalate" (same as `AdapterError`). See class JSDoc for rationale.
 * - AbortSignal is threaded through `invoke` so callers can cancel in-flight
 *   requests; concrete implementations must propagate it to the underlying
 *   network call.
 */

import type { z } from 'zod';
import { HoplonError } from '../contracts/errors.js';
import type { HoplonErrorOptions } from '../contracts/errors.js';

// ---------------------------------------------------------------------------
// TransportError — wire-level failures (extends HoplonError)
// ---------------------------------------------------------------------------

/**
 * Closed union of transport-layer failure kinds.
 *
 * - `malformed_response`   — the wire bytes did not deserialise / validate
 * - `connection_refused`   — TCP/socket connect failed (no remote listener)
 * - `timeout`              — request exceeded deadline; AbortSignal fired
 * - `stream_interrupted`   — streaming response closed before completion
 * - `auth_failed`          — authentication / authorisation rejected by server
 */
export type TransportErrorKind =
  | 'malformed_response'
  | 'connection_refused'
  | 'timeout'
  | 'stream_interrupted'
  | 'auth_failed';

export interface TransportErrorOptions {
  readonly kind: TransportErrorKind;
  readonly engineId: string;
  readonly correlationId: string;
  readonly cause?: unknown;
}

/**
 * Thrown when the transport layer cannot complete a request.
 *
 * Extends `HoplonError` (root of the error hierarchy). Caller response
 * semantics are "escalate" — equivalent to `AdapterError`. The class sits
 * at the adapter layer: transport is a network adapter, and transport failures
 * are adapter-class failures. Callers that `instanceof`-check `TransportError`
 * get the narrowed `TransportErrorKind`; callers that only inspect
 * `HoplonError.kind` see a string discriminant that is always one of the five
 * transport kinds.
 *
 * Note: `AdapterError.kind` is typed as the closed `AdapterErrorKind` union,
 * which does not include transport kinds. To avoid the incompatible-override
 * TypeScript error while preserving the full error hierarchy, `TransportError`
 * extends `HoplonError` directly (whose `kind` is `string`) rather than
 * `AdapterError`.
 *
 * H13 compliance: the constructor accepts `correlationId` but never accepts
 * request body content — ensuring no request payload leaks into error objects.
 */
export class TransportError extends HoplonError {
  /** Narrowed transport-specific kind. */
  override readonly kind: TransportErrorKind;

  constructor(opts: TransportErrorOptions, message?: string) {
    const base: HoplonErrorOptions = {
      kind: opts.kind,
      engineId: opts.engineId,
      correlationId: opts.correlationId,
      cause: opts.cause,
    };
    super(message ?? `Hoplon transport error: ${opts.kind}`, base);
    this.name = 'TransportError';
    this.kind = opts.kind;
  }
}

// ---------------------------------------------------------------------------
// HoplonEngineTransport — wire-protocol abstraction
// ---------------------------------------------------------------------------

/**
 * Abstraction over the wire protocol used to reach a remote Hoplon engine.
 *
 * Wave 2 ships two implementations:
 *   - T1: HTTP server — wraps an in-process engine behind HTTP endpoints
 *   - T2: HTTP client — implements this interface to reach a T1 server
 *
 * The interface is intentionally minimal: one method, `invoke`, with generic
 * request/response types. Concrete implementations handle serialisation,
 * authentication, and streaming; callers only see typed DTOs.
 *
 * @typeParam TReq  - Request DTO type (must be JSON-serialisable)
 * @typeParam TRes  - Response DTO type (must be JSON-serialisable)
 *
 * @param op     - Engine operation name (e.g. 'packContext', 'createSnapshot')
 * @param req    - Validated request DTO
 * @param signal - Optional AbortSignal; implementations must propagate to the
 *                 underlying network call. When the signal fires, the
 *                 implementation must throw `TransportError({ kind: 'timeout' })`
 *                 or `TransportError({ kind: 'stream_interrupted' })`.
 */
export interface HoplonEngineTransport {
  invoke<TReq, TRes>(op: string, req: TReq, signal?: AbortSignal): Promise<TRes>;
}

// ---------------------------------------------------------------------------
// serializeRequest — DTO → wire JSON
// ---------------------------------------------------------------------------

/**
 * Serialise a request DTO to a JSON string, validated through the supplied
 * Zod schema before serialisation.
 *
 * Throws `TransportError({ kind: 'malformed_response' })` if the DTO fails
 * schema validation — this should never happen for well-typed callers but acts
 * as a defensive boundary guard.
 *
 * @param schema - Zod schema for the request type
 * @param data   - Request DTO to serialise
 * @param ctx    - correlationId + engineId for error attribution (H13 — no body
 *                 content flows into the error object)
 * @returns JSON string ready to be placed on the wire
 */
export function serializeRequest<T>(
  schema: z.ZodType<T>,
  data: T,
  ctx: { correlationId: string; engineId: string },
): string {
  const result = schema.safeParse(data);
  if (!result.success) {
    throw new TransportError(
      {
        kind: 'malformed_response',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
        cause: result.error,
      },
      `serializeRequest: DTO failed schema validation: ${result.error.message}`,
    );
  }
  return JSON.stringify(result.data);
}

// ---------------------------------------------------------------------------
// deserializeResponse — wire JSON → DTO
// ---------------------------------------------------------------------------

/**
 * Deserialise a JSON string received from the wire into a typed DTO, validated
 * through the supplied Zod schema.
 *
 * Throws `TransportError({ kind: 'malformed_response' })` if:
 *   - The wire bytes are not valid JSON (JSON.parse throws)
 *   - The parsed object fails Zod schema validation
 *
 * H13 compliance: error messages include the Zod issue list but not the raw
 * wire bytes, preventing accidental leakage of response body content.
 *
 * @param schema   - Zod schema for the expected response type
 * @param wireJson - Raw JSON string received from the wire
 * @param ctx      - correlationId + engineId for error attribution
 * @returns Parsed and validated response DTO
 */
export function deserializeResponse<T>(
  schema: z.ZodType<T>,
  wireJson: string,
  ctx: { correlationId: string; engineId: string },
): T {
  let parsed: unknown;
  try {
    parsed = JSON.parse(wireJson);
  } catch (cause) {
    throw new TransportError(
      {
        kind: 'malformed_response',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
        cause,
      },
      'deserializeResponse: wire bytes are not valid JSON',
    );
  }

  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new TransportError(
      {
        kind: 'malformed_response',
        correlationId: ctx.correlationId,
        engineId: ctx.engineId,
        cause: result.error,
      },
      `deserializeResponse: wire JSON failed schema validation: ${result.error.message}`,
    );
  }

  return result.data;
}
