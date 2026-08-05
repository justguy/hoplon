/**
 * mcp/projectToolErrors.ts — shared typed error envelopes for project tools.
 */

import { HandshakeError } from '../launcher/handshake.js';
import { handshakeErrorDiagnostics } from '../launcher/handshakeErrorDiagnostics.js';
import { buildNoFolderPolicyRecoveryHelp } from '../launcher/projectRecoveryHelp.js';
import {
  buildProjectPolicySurfaceGuidance,
  buildProjectResolutionGuidance,
} from '../util/projectGuidance.js';

export type ToolCallResult = {
  content: Array<{ type: 'text'; text: string }>;
  isError?: boolean;
};

export function toMcpErrorResult(
  err: unknown,
  context: {
    requestedProjectId?: string;
    registeredProjectIds?: readonly string[];
  } = {},
): ToolCallResult {
  if (err instanceof HandshakeError) {
    const envelope: Record<string, unknown> = {
      error: true,
      kind: err.kind,
      message: `Hoplon error: ${err.kind}`,
      ...handshakeErrorDiagnostics(err),
    };
    if (err.kind === 'unknown_project') {
      const requestedProjectId =
        context.requestedProjectId ?? err.projectId;
      const registeredProjectIds =
        context.registeredProjectIds ?? err.registeredProjectIds ?? [];
      Object.assign(
        envelope,
        buildProjectResolutionGuidance({
          kind: 'unknown_project',
          ...(requestedProjectId !== undefined ? { requestedProjectId } : {}),
          registeredProjectIds,
        }),
      );
    }
    if (err.kind === 'no_folder_policy') {
      const requestedProjectId = context.requestedProjectId ?? err.projectId;
      if (requestedProjectId !== undefined) {
        envelope['requestedProjectId'] = requestedProjectId;
        if (typeof envelope['help'] !== 'string') {
          envelope['help'] = buildNoFolderPolicyRecoveryHelp(requestedProjectId);
        }
      }
      envelope['guidance'] = buildProjectPolicySurfaceGuidance({
        hasFolderPolicy: false,
      });
    }
    return {
      content: [{ type: 'text', text: JSON.stringify(envelope) }],
      isError: true,
    };
  }
  const message = err instanceof Error ? err.message : 'unknown_error';
  return {
    content: [
      {
        type: 'text',
        text: JSON.stringify({
          error: true,
          kind: 'internal_error',
          message: `Hoplon error: ${message}`,
        }),
      },
    ],
    isError: true,
  };
}

export function toProjectMcpErrorResult(err: unknown): ToolCallResult {
  return toMcpErrorResult(err);
}
