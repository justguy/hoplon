import type { ZodTypeAny } from 'zod';

import { toMcpInputSchema } from './inputSchema.js';

/** MCP tool content response shape used by engine-backed tools. */
export type EngineToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export interface EngineToolDefinition {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  handler: (args: Record<string, unknown>) => Promise<EngineToolCallResult>;
}

/** Wrap a successful result value as an MCP text content response. */
export function okResult(value: unknown): EngineToolCallResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(value) }],
  };
}

/**
 * Wrap an error as an MCP error content response.
 *
 * H13: only stable error kinds and bounded recovery diagnostics are emitted.
 */
export function errResult(err: unknown): EngineToolCallResult {
  let kind = 'unknown_error';
  let message = 'An internal error occurred.';
  const diagnostics: Record<string, unknown> = {};

  if (err instanceof Error) {
    const asHoplon = err as Error & {
      kind?: string;
      projectId?: string;
      registeredProjectIds?: readonly string[];
      projectIdLooksLikePath?: boolean;
      recoveryHelp?: string;
      recovery?: unknown;
    };
    if (typeof asHoplon.kind === 'string') {
      kind = asHoplon.kind;
    } else {
      kind = err.name ?? 'Error';
    }
    message = `Hoplon error: ${kind}`;
    if (
      (kind === 'unknown_project' || kind === 'no_active_project') &&
      Array.isArray(asHoplon.registeredProjectIds)
    ) {
      diagnostics['registeredProjectIds'] = [...asHoplon.registeredProjectIds];
      diagnostics['help'] =
        typeof asHoplon.recoveryHelp === 'string'
          ? asHoplon.recoveryHelp
          : 'Find or register the target projectId before retrying.';
      if (typeof asHoplon.projectId === 'string') {
        diagnostics['requestedProjectId'] = asHoplon.projectId;
      }
      if (asHoplon.projectIdLooksLikePath === true) {
        diagnostics['projectIdLooksLikePath'] = true;
      }
    }
    if (asHoplon.recovery !== undefined) {
      diagnostics['recovery'] = asHoplon.recovery;
    }
  }

  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({ error: true, kind, message, ...diagnostics }),
      },
    ],
    isError: true,
  };
}

/** MCP requires an object at the input schema root. */
export function toInputSchema(schema: ZodTypeAny): Record<string, unknown> {
  return toMcpInputSchema(schema);
}
