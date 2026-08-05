import { LauncherProjectsError } from '../../launcher/projects.js';
import { HandshakeError } from '../../launcher/handshake.js';
import { handshakeErrorDiagnostics } from '../../launcher/handshakeErrorDiagnostics.js';

export function toProjectRouteError(
  err: unknown,
): {
  error: {
    class: string;
    kind: string;
    message: string;
    reason?: string;
    access?: string;
    help?: string;
    requestedProjectId?: string;
    registeredProjectIds?: readonly string[];
  };
} {
  if (err instanceof LauncherProjectsError) {
    return {
      error: {
        class: 'LauncherProjectsError',
        kind: err.kind,
        message: err.message,
      },
    };
  }
  if (err instanceof HandshakeError) {
    return {
      error: {
        class: 'HandshakeError',
        kind: err.kind,
        message: err.message,
        ...handshakeErrorDiagnostics(err),
      },
    };
  }
  return {
    error: {
      class: 'UnknownError',
      kind: 'internal_error',
      message: err instanceof Error ? err.message : String(err),
    },
  };
}

export function statusForProjectRouteError(err: unknown): number {
  if (err instanceof LauncherProjectsError) {
    if (err.kind === 'registry_error') return 409;
    if (err.kind === 'invalid_fs_root') return 400;
    if (err.kind === 'store_error') return 500;
    if (err.kind === 'persistence_failed') return 500;
  }
  if (err instanceof HandshakeError) {
    if (err.kind === 'invalid_request') return 400;
    if (err.kind === 'unknown_project') return 404;
    if (err.kind === 'no_folder_policy') return 409;
    if (err.kind === 'invalid_folder') return 400;
    if (err.kind === 'unknown_principal') return 400;
    if (err.kind === 'policy_denied') return 403;
  }
  return 500;
}
