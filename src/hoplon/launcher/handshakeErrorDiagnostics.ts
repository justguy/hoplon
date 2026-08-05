/**
 * launcher/handshakeErrorDiagnostics.ts - typed transport diagnostics for
 * HandshakeError without changing transport envelope ownership.
 */

import type { AccessMode, InvalidFolderReason } from '../concurrency/projectPolicy.js';
import type { HandshakeError } from './handshake.js';

export interface HandshakeErrorDiagnostics {
  readonly reason?: InvalidFolderReason;
  readonly access?: AccessMode;
  readonly requestedProjectId?: string;
  readonly registeredProjectIds?: readonly string[];
  readonly help?: string;
}

export function handshakeErrorDiagnostics(
  err: HandshakeError,
): HandshakeErrorDiagnostics {
  const diagnostics: {
    reason?: InvalidFolderReason;
    access?: AccessMode;
    requestedProjectId?: string;
    registeredProjectIds?: readonly string[];
    help?: string;
  } = {};
  if (err.reason !== undefined) diagnostics.reason = err.reason;
  if (err.access !== undefined) diagnostics.access = err.access;
  if (err.projectId !== undefined) diagnostics.requestedProjectId = err.projectId;
  if (err.registeredProjectIds !== undefined) {
    diagnostics.registeredProjectIds = [...err.registeredProjectIds];
  }
  if (err.recoveryHelp !== undefined) diagnostics.help = err.recoveryHelp;
  return diagnostics;
}
