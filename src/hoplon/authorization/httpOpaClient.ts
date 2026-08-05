/**
 * authorization/httpOpaClient.ts — HTTP OPA sidecar client for
 * OpaAuthorizationAdapter.
 *
 * The client wraps adapter input in OPA's `{ input }` data-API envelope and
 * returns only `result` to the adapter for normalization.
 */
import { z } from 'zod';

import type { OpaClient, OpaEvaluateResult } from './opaClient.js';

type FetchFn = typeof globalThis.fetch;

export interface HttpOpaClientDeps {
  readonly baseUrl: string;
  readonly fetchImpl?: FetchFn;
  readonly authorization?: string;
  readonly headers?: Readonly<Record<string, string>>;
}

const OpaDataResponseSchema = z
  .object({
    result: z.unknown(),
  })
  .passthrough();

export class HttpOpaClient implements OpaClient {
  private readonly baseUrl: string;
  private readonly fetchImpl: FetchFn | undefined;
  private readonly authorization: string | undefined;
  private readonly headers: Readonly<Record<string, string>>;

  constructor(deps: HttpOpaClientDeps) {
    this.baseUrl = deps.baseUrl.replace(/\/+$/, '');
    this.fetchImpl = deps.fetchImpl;
    this.authorization = deps.authorization;
    this.headers = deps.headers ?? {};
  }

  async evaluate(
    decisionPath: string,
    input: unknown,
  ): Promise<OpaEvaluateResult> {
    const url = new URL(decisionPath, this.baseUrl);
    let response: Response;
    try {
      response = await (this.fetchImpl ?? globalThis.fetch)(url, {
        method: 'POST',
        headers: this.buildHeaders(),
        body: JSON.stringify({ input }),
      });
    } catch (err) {
      return { kind: 'error', reason: `network_error: ${describeError(err)}` };
    }

    const raw = await readText(response);
    if (raw.kind === 'error') return raw;
    if (!response.ok) {
      return {
        kind: 'error',
        reason: `http_${String(response.status)}: ${raw.text}`,
      };
    }
    const parsed = parseJson(raw.text);
    if (parsed.kind === 'error') return parsed;
    const envelope = OpaDataResponseSchema.safeParse(parsed.value);
    if (!envelope.success) {
      return {
        kind: 'error',
        reason: `malformed_response: ${envelope.error.message}`,
      };
    }
    if (
      parsed.value === null ||
      typeof parsed.value !== 'object' ||
      !Object.prototype.hasOwnProperty.call(parsed.value, 'result')
    ) {
      return {
        kind: 'error',
        reason: 'malformed_response: missing result',
      };
    }
    return { kind: 'ok', raw: envelope.data.result };
  }

  private buildHeaders(): Record<string, string> {
    const out: Record<string, string> = {
      Accept: 'application/json',
      'Content-Type': 'application/json',
      ...this.headers,
    };
    if (this.authorization !== undefined) {
      out['Authorization'] = this.authorization;
    }
    return out;
  }
}

async function readText(
  response: Response,
): Promise<{ kind: 'ok'; text: string } | { kind: 'error'; reason: string }> {
  try {
    return { kind: 'ok', text: await response.text() };
  } catch (err) {
    return { kind: 'error', reason: `body_read_failed: ${describeError(err)}` };
  }
}

function parseJson(
  raw: string,
): { kind: 'ok'; value: unknown } | { kind: 'error'; reason: string } {
  try {
    return { kind: 'ok', value: JSON.parse(raw) as unknown };
  } catch (err) {
    return { kind: 'error', reason: `json_parse_failed: ${describeError(err)}` };
  }
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
