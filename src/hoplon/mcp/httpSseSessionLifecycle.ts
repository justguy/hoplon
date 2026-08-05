import type { ServerResponse } from 'node:http';

import type { SSEServerTransport } from '@modelcontextprotocol/sdk/server/sse.js';

export type HttpSseTransportCleanup = () => void | Promise<void>;

export interface ActiveSseSession {
  readonly transport: SSEServerTransport;
  readonly response: ServerResponse;
  cleanup?: HttpSseTransportCleanup;
  attachmentComplete: boolean;
  cleanupStarted: boolean;
  closed: boolean;
  readonly closedPromise: Promise<void>;
  readonly resolveClosed: () => void;
}

export interface SseSessionLifecycle {
  register(
    transport: SSEServerTransport,
    response: ServerResponse,
  ): ActiveSseSession;
  attach(
    active: ActiveSseSession,
    cleanup: HttpSseTransportCleanup | undefined,
  ): void;
  attachmentFailed(active: ActiveSseSession): void;
  getOpen(sessionId: string): ActiveSseSession | undefined;
  close(sessionId: string, active: ActiveSseSession): void;
  waitForClose(sessionId: string): Promise<void>;
  closeAll(): Promise<unknown[]>;
}

export function createSseSessionLifecycle(): SseSessionLifecycle {
  const sessions = new Map<string, ActiveSseSession>();
  const closePromises = new Map<string, Promise<void>>();
  const cleanupErrors: unknown[] = [];

  const maybeRunCleanup = (
    sessionId: string,
    active: ActiveSseSession,
  ): void => {
    if (
      !active.closed ||
      !active.attachmentComplete ||
      active.cleanupStarted
    ) {
      return;
    }
    active.cleanupStarted = true;
    const cleanup = active.cleanup;
    delete active.cleanup;
    void Promise.resolve()
      .then(() => cleanup?.())
      .catch((error: unknown) => {
        cleanupErrors.push(error);
      })
      .finally(() => {
        active.resolveClosed();
        if (closePromises.get(sessionId) === active.closedPromise) {
          closePromises.delete(sessionId);
        }
      });
  };

  const close = (sessionId: string, active: ActiveSseSession): void => {
    if (active.closed) return;
    active.closed = true;
    if (sessions.get(sessionId) === active) sessions.delete(sessionId);
    // Cleanup starts in a microtask, after every ServerResponse close listener
    // (including the MCP SDK Protocol listener) has completed.
    maybeRunCleanup(sessionId, active);
  };

  return {
    register(transport, response) {
      let resolveClosed!: () => void;
      const closedPromise = new Promise<void>((resolve) => {
        resolveClosed = resolve;
      });
      const active: ActiveSseSession = {
        transport,
        response,
        attachmentComplete: false,
        cleanupStarted: false,
        closed: false,
        closedPromise,
        resolveClosed,
      };
      sessions.set(transport.sessionId, active);
      closePromises.set(transport.sessionId, closedPromise);
      return active;
    },
    attach(active, cleanup) {
      if (cleanup !== undefined) active.cleanup = cleanup;
      active.attachmentComplete = true;
      if (active.closed) maybeRunCleanup(active.transport.sessionId, active);
    },
    attachmentFailed(active) {
      active.attachmentComplete = true;
      if (active.closed) maybeRunCleanup(active.transport.sessionId, active);
    },
    getOpen(sessionId) {
      const active = sessions.get(sessionId);
      if (active === undefined || active.closed) return undefined;
      if (
        active.response.destroyed ||
        active.response.writableEnded ||
        active.response.socket?.destroyed === true
      ) {
        close(sessionId, active);
        return undefined;
      }
      return active;
    },
    close,
    waitForClose(sessionId) {
      return closePromises.get(sessionId) ?? Promise.resolve();
    },
    async closeAll() {
      const activeSessions = [...sessions.entries()];
      await Promise.all(
        activeSessions.map(async ([sessionId, active]) => {
          try {
            await active.transport.close();
          } catch (error) {
            cleanupErrors.push(error);
          } finally {
            close(sessionId, active);
          }
        }),
      );
      await Promise.all([...closePromises.values()]);
      return [...cleanupErrors];
    },
  };
}
