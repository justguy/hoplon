import type { ZodTypeAny } from 'zod';

import {
  SessionError,
  toSessionErrorTransportDetails,
} from '../session/errors.js';
import { SessionTransportError } from '../session/transport.js';
import { toMcpInputSchema } from './inputSchema.js';

export type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface SessionToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<ToolCallResult>;
}

export function toInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  return toMcpInputSchema(schema);
}

export function okResult(value: unknown): ToolCallResult {
  return { content: [{ type: 'text', text: JSON.stringify(value) }] };
}

function readSessionId(args: Record<string, unknown> | undefined): string | undefined {
  const sessionId = args?.['sessionId'];
  return typeof sessionId === 'string' && sessionId.length > 0 ? sessionId : undefined;
}

export function errResult(
  err: unknown,
  args?: Record<string, unknown>,
): ToolCallResult {
  let kind = 'unknown_error';
  let errorClass = 'Error';
  let message = `Hoplon session error: ${kind}`;
  let sessionId: string | undefined;
  let guidance: string | undefined;
  let details: unknown;

  if (err instanceof SessionTransportError) {
    errorClass = 'SessionTransportError';
    kind = err.kind;
    sessionId = err.sessionId;
    message = err.message;
    guidance = err.guidance;
  } else if (err instanceof SessionError) {
    errorClass = 'SessionError';
    kind = err.kind;
    sessionId = err.correlationId ?? readSessionId(args);
    message = `Hoplon session error: ${kind}`;
    details = toSessionErrorTransportDetails(err);
  } else if (err instanceof Error) {
    const asHoplon = err as Error & { kind?: string };
    errorClass = err.name || 'Error';
    kind = typeof asHoplon.kind === 'string' ? asHoplon.kind : err.name || 'Error';
    message = `Hoplon session error: ${kind}`;
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          class: errorClass,
          kind,
          message,
          ...(sessionId !== undefined ? { sessionId } : {}),
          ...(guidance !== undefined ? { guidance } : {}),
          ...(details !== undefined ? { details } : {}),
        }),
      },
    ],
    isError: true,
  };
}

export function handlerFor<T>(
  dispatch: (args: Record<string, unknown>) => Promise<T>,
  guard?: (args: Record<string, unknown>) => Promise<void>,
): (args: Record<string, unknown>) => Promise<ToolCallResult> {
  return async (args) => {
    try {
      if (guard) await guard(args);
      const result = await dispatch(args);
      return okResult(result);
    } catch (err) {
      return errResult(err, args);
    }
  };
}
