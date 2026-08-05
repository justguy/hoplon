import type { ServerResponse } from 'node:http';

import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';
import { describe, expect, it } from 'vitest';

import {
  createSseSessionLifecycle,
} from '../../src/hoplon/mcp/httpSseSessionLifecycle.js';

function fakeSession(sessionId: string): {
  transport: SSEServerTransport;
  response: ServerResponse;
  closeCalls: () => number;
  destroyResponse: () => void;
} {
  let closes = 0;
  const responseState = {
    destroyed: false,
    writableEnded: false,
    socket: { destroyed: false },
  };
  const transport = {
    sessionId,
    close: async () => {
      closes += 1;
    },
  } as unknown as SSEServerTransport;
  return {
    transport,
    response: responseState as unknown as ServerResponse,
    closeCalls: () => closes,
    destroyResponse: () => {
      responseState.destroyed = true;
      responseState.socket.destroyed = true;
    },
  };
}

describe('SSE server-side session lifecycle', () => {
  it('acknowledges close only after the returned session cleanup completes', async () => {
    const lifecycle = createSseSessionLifecycle();
    const fixture = fakeSession('session-a');
    const active = lifecycle.register(fixture.transport, fixture.response);
    let releaseCleanup!: () => void;
    const cleanupGate = new Promise<void>((resolve) => {
      releaseCleanup = resolve;
    });
    let cleaned = false;
    lifecycle.attach(active, async () => {
      await cleanupGate;
      cleaned = true;
    });
    const serverClosed = lifecycle.waitForClose('session-a');
    let acknowledged = false;
    void serverClosed.then(() => {
      acknowledged = true;
    });

    lifecycle.close('session-a', active);
    expect(lifecycle.getOpen('session-a')).toBeUndefined();
    await Promise.resolve();
    expect(acknowledged).toBe(false);

    releaseCleanup();
    await serverClosed;
    expect(cleaned).toBe(true);
    expect(acknowledged).toBe(true);
  });

  it('handles a server response closing before transport attachment finishes', async () => {
    const lifecycle = createSseSessionLifecycle();
    const fixture = fakeSession('session-b');
    const active = lifecycle.register(fixture.transport, fixture.response);
    const serverClosed = lifecycle.waitForClose('session-b');
    let cleaned = false;

    lifecycle.close('session-b', active);
    lifecycle.attach(active, () => {
      cleaned = true;
    });
    await serverClosed;

    expect(cleaned).toBe(true);
    expect(lifecycle.getOpen('session-b')).toBeUndefined();
  });

  it('rejects destroyed responses and closes all remaining sessions deterministically', async () => {
    const lifecycle = createSseSessionLifecycle();
    const stale = fakeSession('session-stale');
    const staleActive = lifecycle.register(stale.transport, stale.response);
    lifecycle.attach(staleActive, undefined);
    const staleClosed = lifecycle.waitForClose('session-stale');
    stale.destroyResponse();

    expect(lifecycle.getOpen('session-stale')).toBeUndefined();
    await staleClosed;

    const live = fakeSession('session-live');
    const liveActive = lifecycle.register(live.transport, live.response);
    let cleaned = false;
    lifecycle.attach(liveActive, () => {
      cleaned = true;
    });
    const errors = await lifecycle.closeAll();

    expect(errors).toEqual([]);
    expect(live.closeCalls()).toBe(1);
    expect(cleaned).toBe(true);
    expect(lifecycle.getOpen('session-live')).toBeUndefined();
  });
});
