/** Durable trace read/export HTTP routes. */

import type { FastifyReply, FastifyRequest } from 'fastify';

import {
  authorizeTraceEnterpriseAccess,
  parseTraceFilters,
  runTraceRoute,
} from './traceRouteSupport.js';
import type { TraceHttpRoutesOptions } from './traceRouteSupport.js';

export type { TraceHttpRoutesOptions } from './traceRouteSupport.js';

export function registerTraceHttpRoutes(opts: TraceHttpRoutesOptions): void {
  const { server, traceStore } = opts;

  server.get('/executions', (req: FastifyRequest, reply: FastifyReply) =>
    runTraceRoute(reply, opts, async () => {
      const executions = await traceStore.listExecutions(parseTraceFilters(req.query));
      return { executions };
    }),
  );

  server.get('/executions/:executionId', (req: FastifyRequest, reply: FastifyReply) => {
    const { executionId } = req.params as { executionId: string };
    return runTraceRoute(reply, opts, async () => {
      const execution = await traceStore.getExecution(executionId);
      if (!execution) {
        await reply.status(404).send({
          error: {
            class: 'NotFound',
            kind: 'execution_not_found',
            message: `execution_not_found: ${executionId} not found`,
            correlationId: executionId,
          },
        });
        return undefined;
      }
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'raw_proof',
        objectType: 'execution',
        objectRef: executionId,
        projectId: execution.projectId,
        runId: execution.runId,
      });
      if (!ok) return undefined;
      const [attempts, proofBundles, provenance] = await Promise.all([
        traceStore.listAttempts(executionId),
        traceStore.listProofBundles(executionId),
        traceStore.listProvenance(executionId),
      ]);
      return { execution, attempts, proofBundles, provenance };
    });
  });

  server.get('/attempts/:attemptId', (req: FastifyRequest, reply: FastifyReply) => {
    const { attemptId } = req.params as { attemptId: string };
    return runTraceRoute(reply, opts, async () => {
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'raw_proof',
        objectType: 'execution',
        objectRef: attemptId,
        projectId: null,
        runId: null,
      });
      if (!ok) return undefined;
      const attempt = await traceStore.getAttempt(attemptId);
      if (!attempt) {
        await reply.status(404).send({
          error: {
            class: 'NotFound',
            kind: 'attempt_not_found',
            message: `attempt_not_found: ${attemptId} not found`,
            correlationId: attemptId,
          },
        });
        return undefined;
      }
      return attempt;
    });
  });

  server.get('/proof/:proofBundleRef', (req: FastifyRequest, reply: FastifyReply) => {
    const { proofBundleRef } = req.params as { proofBundleRef: string };
    return runTraceRoute(reply, opts, async () => {
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'raw_proof',
        objectType: 'proof_bundle',
        objectRef: proofBundleRef,
        projectId: null,
        runId: null,
      });
      if (!ok) return undefined;
      const bundle = await traceStore.getProofBundle(proofBundleRef);
      if (!bundle) {
        await reply.status(404).send({
          error: {
            class: 'NotFound',
            kind: 'proof_bundle_not_found',
            message: `proof_bundle_not_found: ${proofBundleRef} not found`,
            correlationId: proofBundleRef,
          },
        });
        return undefined;
      }
      const violations = await traceStore.listViolations(proofBundleRef);
      return { bundle, violations };
    });
  });

  server.get('/audits/:auditRef', (req: FastifyRequest, reply: FastifyReply) => {
    const { auditRef } = req.params as { auditRef: string };
    return runTraceRoute(reply, opts, async () => {
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'raw_proof',
        objectType: 'execution',
        objectRef: auditRef,
        projectId: null,
        runId: null,
      });
      if (!ok) return undefined;
      const attempts = await traceStore.searchAttempts({ auditRef });
      return { auditRef, attempts };
    });
  });

  server.get('/violations/:violationId', (req: FastifyRequest, reply: FastifyReply) => {
    const { violationId } = req.params as { violationId: string };
    return runTraceRoute(reply, opts, async () => {
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'raw_proof',
        objectType: 'violation',
        objectRef: violationId,
        projectId: null,
        runId: null,
      });
      if (!ok) return undefined;
      const violation = await traceStore.getViolation(violationId);
      if (!violation) {
        await reply.status(404).send({
          error: {
            class: 'NotFound',
            kind: 'violation_not_found',
            message: `violation_not_found: ${violationId} not found`,
            correlationId: violationId,
          },
        });
        return undefined;
      }
      return violation;
    });
  });

  server.get('/search', (req: FastifyRequest, reply: FastifyReply) =>
    runTraceRoute(reply, opts, async () => {
      const filters = parseTraceFilters(req.query);
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'raw_proof',
        objectType: 'execution',
        objectRef: 'search',
        projectId: filters.projectId ?? null,
        runId: filters.runId ?? null,
      });
      if (!ok) return undefined;
      const attempts = await traceStore.searchAttempts(filters);
      return { filters, attempts };
    }),
  );

  server.post('/executions/:executionId/export', (req: FastifyRequest, reply: FastifyReply) => {
    const { executionId } = req.params as { executionId: string };
    return runTraceRoute(reply, opts, async () => {
      const execution = await traceStore.getExecution(executionId);
      if (!execution) {
        await reply.status(404).send({
          error: {
            class: 'NotFound',
            kind: 'execution_not_found',
            message: `execution_not_found: ${executionId} not found`,
            correlationId: executionId,
          },
        });
        return undefined;
      }
      const ok = await authorizeTraceEnterpriseAccess(req, reply, opts, {
        accessClass: 'export',
        objectType: 'export_bundle',
        objectRef: executionId,
        projectId: execution.projectId,
        runId: execution.runId,
      });
      if (!ok) return undefined;
      const bundle = await traceStore.exportExecution(executionId);
      if (!bundle) {
        await reply.status(404).send({
          error: {
            class: 'NotFound',
            kind: 'execution_not_found',
            message: `execution_not_found: ${executionId} not found`,
            correlationId: executionId,
          },
        });
        return undefined;
      }
      return bundle;
    });
  });
}
