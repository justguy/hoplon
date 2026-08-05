/** Packaged HTTP session routes. */

import type { FastifyReply, FastifyRequest } from 'fastify';

import { STAGE_MAX_CHUNK_BYTES } from '../../session/stagingStore.js';
import {
  createSessionTransportDispatcher,
  SessionTransportError,
} from '../../session/transport.js';
import type { SessionTransportDispatcher } from '../../session/transport.js';
import {
  isHttpSessionOpAllowedForAgentProfile,
} from '../agentToolProfile.js';
import type { HttpSessionOp } from '../agentToolProfile.js';
import { StrictEngagementError } from '../strictEngagementGate.js';
import { strictScopedSessionList } from '../strictSessionList.js';
import {
  runSessionRouteOp,
  sessionTransportEnvelope,
} from './sessionRouteSupport.js';
import type { SessionHttpRoutesOptions } from './sessionRouteSupport.js';

export type { SessionHttpRoutesOptions } from './sessionRouteSupport.js';

export const SESSION_STAGE_CONTENT_BODY_LIMIT = Math.ceil(
  (STAGE_MAX_CHUNK_BYTES * 4) / 3 + 64 * 1024,
);

export function registerSessionHttpRoutes(
  opts: SessionHttpRoutesOptions,
): SessionTransportDispatcher {
  const dispatcher = createSessionTransportDispatcher({ registry: opts.registry });
  const { server } = opts;
  const allow = (op: HttpSessionOp) =>
    isHttpSessionOpAllowedForAgentProfile(opts.agentToolProfile, op);
  const run = <T>(
    req: FastifyRequest,
    reply: FastifyReply,
    op: HttpSessionOp,
    invoke: () => Promise<T>,
  ) => runSessionRouteOp(req.body, reply, opts, op, invoke);

  if (allow('start')) {
    server.post('/session/start', (req, reply) =>
      run(req, reply, 'start', () => dispatcher.start(req.body)));
  }
  if (allow('preflight')) {
    server.post('/session/preflight', (req, reply) =>
      run(req, reply, 'preflight', () => dispatcher.preflight(req.body)));
  }
  if (allow('createSnapshot')) {
    server.post('/session/createSnapshot', (req, reply) =>
      run(req, reply, 'createSnapshot', () => dispatcher.createSnapshot(req.body)));
  }
  if (allow('dryRun')) {
    server.post('/session/dryRun', (req, reply) =>
      run(req, reply, 'dryRun', () => dispatcher.dryRun(req.body)));
  }
  if (allow('applyEdits')) {
    server.post('/session/applyEdits', (req, reply) =>
      run(req, reply, 'applyEdits', () => dispatcher.applyEdits(req.body)));
  }
  if (allow('stageContent')) {
    server.post(
      '/session/stageContent',
      { bodyLimit: SESSION_STAGE_CONTENT_BODY_LIMIT },
      (req, reply) => run(req, reply, 'stageContent', () => dispatcher.stageContent(req.body)),
    );
  }
  if (allow('markEdited')) {
    server.post('/session/markEdited', (req, reply) =>
      run(req, reply, 'markEdited', () => dispatcher.markEdited(req.body)));
  }
  if (allow('audit')) {
    server.post('/session/audit', (req, reply) =>
      run(req, reply, 'audit', () => dispatcher.audit(req.body)));
  }
  if (allow('revert')) {
    server.post('/session/revert', (req, reply) =>
      run(req, reply, 'revert', () => dispatcher.revert(req.body)));
  }
  if (allow('extractRollbackTemplate')) {
    server.post('/session/extractRollbackTemplate', (req, reply) =>
      run(req, reply, 'extractRollbackTemplate', () =>
        dispatcher.extractRollbackTemplate(req.body)));
  }
  if (allow('getRepairContext')) {
    server.post('/session/getRepairContext', (req, reply) =>
      run(req, reply, 'getRepairContext', () => dispatcher.getRepairContext(req.body)));
  }
  if (allow('getCloseoutProofBundle')) {
    server.post('/session/getCloseoutProofBundle', (req, reply) =>
      run(req, reply, 'getCloseoutProofBundle', () =>
        dispatcher.getCloseoutProofBundle(req.body)));
  }
  if (allow('review')) {
    server.post('/session/review', (req, reply) =>
      run(req, reply, 'review', () => dispatcher.getReviewPayload(req.body)));
  }
  if (allow('verifyBehavior')) {
    server.post('/session/verifyBehavior', (req, reply) =>
      run(req, reply, 'verifyBehavior', () => dispatcher.verifyBehavior(req.body)));
  }
  if (allow('inspect')) {
    server.post('/session/inspect', (req, reply) =>
      run(req, reply, 'inspect', () => dispatcher.inspect(req.body)));
  }
  if (allow('close')) {
    server.post('/session/close', (req, reply) =>
      run(req, reply, 'close', () => dispatcher.close(req.body)));
  }
  if (allow('list')) registerListRoutes(opts, dispatcher);
  if (allow('quickEdit')) {
    server.post('/session/quickEdit', (req, reply) =>
      run(req, reply, 'quickEdit', () => dispatcher.quickEdit(req.body)));
  }
  if (allow('targetFirstScopedEdit')) {
    server.post('/session/targetFirstScopedEdit', (req, reply) =>
      run(req, reply, 'targetFirstScopedEdit', () =>
        dispatcher.targetFirstScopedEdit(req.body)));
  }
  if (allow('snapshotEvidence')) {
    server.post('/session/snapshotEvidence', (req, reply) =>
      run(req, reply, 'snapshotEvidence', () =>
        dispatcher.getSnapshotEvidence(req.body)));
  }
  return dispatcher;
}

function registerListRoutes(
  opts: SessionHttpRoutesOptions,
  dispatcher: SessionTransportDispatcher,
): void {
  const { server, strictEngagementGate } = opts;
  if (strictEngagementGate === undefined) {
    server.get('/session/list', (_req, reply) =>
      reply.status(200).send(dispatcher.list()));
    return;
  }

  server.get('/session/list', async (_req, reply) => {
    const { status, body } = opts.toEngineErrorEnvelope(
      new StrictEngagementError({
        kind: 'engagement_missing_or_revoked',
        correlationId: 'session-list',
        statusCode: 401,
      }),
    );
    await reply.status(status).send(body);
  });
  server.post('/session/list', async (req, reply) => {
    try {
      const result = await strictScopedSessionList({
        gate: strictEngagementGate,
        registry: opts.registry,
        rawBody: req.body,
      });
      await reply.status(200).send(result);
    } catch (err) {
      if (err instanceof SessionTransportError) {
        const { status, body } = sessionTransportEnvelope(err);
        await reply.status(status).send(body);
        return;
      }
      const { status, body } = opts.toEngineErrorEnvelope(err);
      await reply.status(status).send(body);
    }
  });
}
