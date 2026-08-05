import type { z } from 'zod';

import type { HoplonEditSession } from './types.js';
import type {
  RegisteredSessionEntry,
  SessionRegistry,
} from './registry.js';
import type {
  SESSION_TRANSPORT_ERROR_KINDS,
  SessionIdentity,
  SessionResponse,
  SessionSnapshotEvidenceRequest,
} from './transportContracts.js';
import type { SnapshotEvidenceLineTarget } from './snapshotEvidenceTypes.js';

export type SessionTransportErrorKind =
  (typeof SESSION_TRANSPORT_ERROR_KINDS)[number];

export class SessionTransportError extends Error {
  readonly kind: SessionTransportErrorKind;
  readonly sessionId: string | undefined;
  readonly guidance: string | undefined;

  constructor(
    kind: SessionTransportErrorKind,
    message: string,
    sessionIdOrOpts?: string | { sessionId?: string; guidance?: string },
  ) {
    super(message);
    this.name = 'SessionTransportError';
    this.kind = kind;
    if (typeof sessionIdOrOpts === 'string') {
      this.sessionId = sessionIdOrOpts;
    } else if (sessionIdOrOpts !== undefined) {
      if (sessionIdOrOpts.sessionId !== undefined) {
        this.sessionId = sessionIdOrOpts.sessionId;
      }
      if (sessionIdOrOpts.guidance !== undefined) {
        this.guidance = sessionIdOrOpts.guidance;
      }
    }
  }
}

const MISSING_SESSION_ID_GUIDANCE =
  'This call must include sessionId. First call start_edit_session (MCP) ' +
  'or POST /session/start (HTTP), then pass the returned session.sessionId ' +
  'as sessionId on this call.';

function isMissingSessionId(rawBody: unknown): boolean {
  if (typeof rawBody !== 'object' || rawBody === null || !('sessionId' in rawBody)) {
    return true;
  }
  const { sessionId } = rawBody as { sessionId?: unknown };
  return sessionId === undefined;
}

export function toIdentity(entry: RegisteredSessionEntry): SessionIdentity {
  return {
    sessionId: entry.sessionId,
    projectId: entry.projectId,
    runId: entry.runId,
    correlationId: entry.correlationId,
    createdAtMs: entry.createdAtMs,
  };
}

export function wrap<T>(
  entry: RegisteredSessionEntry,
  session: HoplonEditSession,
  data: T,
): SessionResponse<T> {
  return {
    session: toIdentity(entry),
    state: session.state,
    historyLength: session.snapshot.history.length,
    data,
  };
}

export function parseOrThrow<S extends z.ZodTypeAny>(
  schema: S,
  rawBody: unknown,
  opLabel: string,
  opts: { requireSessionId?: boolean } = {},
): z.infer<S> {
  const parsed = schema.safeParse(rawBody);
  if (!parsed.success) {
    const guidance =
      opts.requireSessionId === true && isMissingSessionId(rawBody)
        ? MISSING_SESSION_ID_GUIDANCE
        : undefined;
    const message =
      guidance === undefined
        ? `${opLabel}: invalid request body: ${parsed.error.message}`
        : `${opLabel}: invalid request body: ${parsed.error.message} ${guidance}`;
    throw new SessionTransportError(
      'invalid_request',
      message,
      guidance === undefined ? undefined : { guidance },
    );
  }
  return parsed.data;
}

export function requireEntry(
  registry: SessionRegistry,
  sessionId: string,
): RegisteredSessionEntry {
  const entry = registry.get(sessionId);
  if (!entry) {
    throw new SessionTransportError(
      'session_not_found',
      `session not found: ${sessionId}`,
      sessionId,
    );
  }
  return entry;
}

export function toLineEvidenceTarget(
  target: Extract<
    SessionSnapshotEvidenceRequest['request'],
    { kind: 'line_provenance' }
  >['target'],
): SnapshotEvidenceLineTarget {
  if (target.kind === 'line_range') {
    return { kind: 'line_range', lineRange: target.lineRange };
  }
  const syntaxNode: {
    nodeKind?: string;
    byteRange?: readonly [number, number];
    lineRange: { startLine: number; endLine: number };
  } = { lineRange: target.syntaxNode.lineRange };
  if (target.syntaxNode.nodeKind !== undefined) {
    syntaxNode.nodeKind = target.syntaxNode.nodeKind;
  }
  if (target.syntaxNode.byteRange !== undefined) {
    syntaxNode.byteRange = target.syntaxNode.byteRange;
  }
  return { kind: 'syntax_node', syntaxNode };
}
