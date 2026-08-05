/**
 * transport/http/projectsGuidanceErrors.ts — additive agent guidance for
 * project-policy HTTP error envelopes.
 */

import { HandshakeError } from '../../launcher/handshake.js';
import { buildNoFolderPolicyRecoveryHelp } from '../../launcher/projectRecoveryHelp.js';
import {
  buildProjectPolicySurfaceGuidance,
  buildProjectResolutionGuidance,
} from '../../util/projectGuidance.js';

export function extendHandshakeErrorGuidance(
  base: unknown,
  err: unknown,
  context: {
    requestedProjectId?: string;
    registeredProjectIds?: readonly string[];
  },
): unknown {
  if (!(err instanceof HandshakeError)) return base;
  if (base === null || typeof base !== 'object') return base;

  const cloned = { ...(base as Record<string, unknown>) };
  const inner = cloned['error'];
  if (inner === null || typeof inner !== 'object') return cloned;

  const error = { ...(inner as Record<string, unknown>) };
  if (err.kind === 'unknown_project') {
    const requestedProjectId = context.requestedProjectId ?? err.projectId;
    Object.assign(
      error,
      buildProjectResolutionGuidance({
        kind: 'unknown_project',
        ...(requestedProjectId !== undefined ? { requestedProjectId } : {}),
        registeredProjectIds: context.registeredProjectIds ?? [],
      }),
    );
  }
  if (err.kind === 'no_folder_policy') {
    const requestedProjectId = context.requestedProjectId ?? err.projectId;
    if (requestedProjectId !== undefined) {
      error['requestedProjectId'] = requestedProjectId;
      if (typeof error['help'] !== 'string') {
        error['help'] = buildNoFolderPolicyRecoveryHelp(requestedProjectId);
      }
    }
    error['guidance'] = buildProjectPolicySurfaceGuidance({
      hasFolderPolicy: false,
    });
  }
  cloned['error'] = error;
  return cloned;
}
