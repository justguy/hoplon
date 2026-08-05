/**
 * transport/http/policyAuditContext.ts — shared request → PolicyAuditContext
 * helpers for the t-088 HTTP policy-audit hooks.
 *
 * Extracted from `projectsRoutes.ts` / `projectsLifecycleRoutes.ts` so the
 * route files stay under the 300-line architecture cap and both surfaces
 * resolve the audit context identically. Operators that route incoming
 * correlation ids via headers get consistent `runId` / `correlationId`
 * pairs regardless of which projects endpoint is hit.
 */

import type { FastifyRequest } from 'fastify';
import type { PolicyAuditContext } from '../policyAuditSink.js';

/** Default policy-audit context resolver for project HTTP routes. */
export function defaultPolicyAuditContext(
  req: FastifyRequest,
): PolicyAuditContext {
  const projectId = stringFromBody(req, 'projectId') ?? 'unknown';
  return fallbackAuditContext(req, projectId);
}

/** Helper: pull a string body field or null if absent/empty. */
export function stringFromBody(req: FastifyRequest, key: string): string | null {
  const body = (req.body ?? {}) as Record<string, unknown>;
  const v = body[key];
  return typeof v === 'string' && v.length > 0 ? v : null;
}

/** Build a PolicyAuditContext for a request whose projectId is known. */
export function fallbackAuditContext(
  req: FastifyRequest,
  projectId: string,
): PolicyAuditContext {
  const headers = req.headers ?? {};
  const correlationId =
    pickHeader(headers['x-correlation-id']) ?? req.id ?? 'http';
  const runId = pickHeader(headers['x-run-id']) ?? correlationId;
  return { projectId, runId, correlationId };
}

function pickHeader(v: unknown): string | null {
  if (typeof v === 'string' && v.length > 0) return v;
  if (Array.isArray(v) && v.length > 0 && typeof v[0] === 'string') {
    return (v[0] as string).length > 0 ? (v[0] as string) : null;
  }
  return null;
}
