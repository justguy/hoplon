/**
 * tests/transport/policyAuditMapping.test.ts — pure t-088 audit mapping
 * checks for content-safe denied-handshake metadata.
 */
import { describe, expect, it } from 'vitest';

import { HandshakeError } from '../../src/hoplon/launcher/handshake.js';
import { handshakeDenyEvent } from '../../src/hoplon/transport/policyAuditMapping.js';

describe('policy audit mapping', () => {
  it('does not persist raw invalid folder bytes on denied handshakes', () => {
    const event = handshakeDenyEvent(
      { projectId: 'p1', folder: '../secret' },
      new HandshakeError('invalid_folder', 'bad folder', {
        projectId: 'p1',
        reason: 'parent_segment',
      }),
    );

    expect(event.reasonCode).toBe('handshake_invalid_folder');
    expect(event.folder).toBeNull();
    expect(event.detail).toBe('parent_segment');
  });

  it('keeps declared principal ids intact instead of truncating them', () => {
    const principalId = `principal-${'x'.repeat(240)}`;
    const event = handshakeDenyEvent(
      { projectId: 'p1', folder: 'src', principalId },
      new HandshakeError('unknown_principal', 'unknown principal', {
        projectId: 'p1',
      }),
    );

    expect(event.reasonCode).toBe('handshake_unknown_principal');
    expect(event.folder).toBe('src');
    expect(event.principalId).toBe(principalId);
  });
});
