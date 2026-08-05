/**
 * transport/http/projectsHandshakeRequest.ts — request body parsing for the
 * project handshake HTTP route.
 */

import { HandshakeError } from '../../launcher/handshake.js';

export function requireHandshakeString(
  body: Record<string, unknown> | undefined,
  key: string,
): string {
  const v = body?.[key];
  if (typeof v !== 'string' || v.length === 0) {
    throw new HandshakeError(
      'invalid_request',
      `Missing or invalid '${key}' in request body`,
    );
  }
  return v;
}

export function requireHandshakeFolder(
  body: Record<string, unknown> | undefined,
): string {
  const v = body?.['folder'];
  if (typeof v !== 'string') {
    throw new HandshakeError(
      'invalid_request',
      "Missing or invalid 'folder' in request body",
    );
  }
  return v;
}

export function optionalHandshakePrincipalId(
  body: Record<string, unknown>,
): string | undefined {
  if (!Object.prototype.hasOwnProperty.call(body, 'principalId')) {
    return undefined;
  }
  const v = body['principalId'];
  if (typeof v !== 'string' || v.length === 0) {
    throw new HandshakeError(
      'invalid_request',
      `Missing or invalid 'principalId' in request body`,
    );
  }
  return v;
}
