import { StrictEngagementContextSchema } from '../contracts/engagementContext.js';
import type { GatedAction } from './policyAuditSink.js';
import { deriveStrictCapabilityAstScope } from './strictCapabilityAstScope.js';
import {
  StrictEngagementError,
  type StrictEngagementCheck,
} from './strictEngagementGate.js';

export function strictEngineCheckFromBody(
  method: string,
  body: unknown,
): StrictEngagementCheck | null {
  if (!isStrictEngineMethod(method)) return null;
  if (typeof body !== 'object' || body === null) return null;
  const raw = body as Record<string, unknown>;
  const projectId = stringField(raw, 'projectId');
  const runId = stringField(raw, 'runId');
  const correlationId = stringField(raw, 'correlationId');
  if (!projectId || !runId || !correlationId) return null;
  const engagement = parseEngagementContext(raw['engagement'], correlationId);
  const capability = strictCapabilityFromBody(raw, correlationId);
  const action = actionForEngineMethod(method, raw);
  const derivedAst = deriveStrictCapabilityAstScope(method, raw);
  return {
    ...(engagement !== undefined ? { engagement } : {}),
    projectId,
    runId,
    correlationId,
    action,
    requiredAccess: 'read_only',
    ...(capability !== undefined ? { capability } : {}),
    // hcr-004 finding 5 — capability facts derived from the actual request
    // targets. Enforce-mode capability checks run over these facts; the
    // caller-described `capability` spec above is only validated against
    // them. Branch is '' — the transport cannot derive one.
    derivedCapability: {
      key: action === 'search' ? 'search' : 'read',
      branch: '',
      paths: deriveEngineTargetPaths(method, raw),
      ...(derivedAst.astNodeIds.length > 0
        ? { astNodeIds: derivedAst.astNodeIds }
        : {}),
      ...(derivedAst.astSelectors.length > 0
        ? { astSelectors: derivedAst.astSelectors }
        : {}),
    },
  };
}

/**
 * Derive the project-relative paths an engine read/search request actually
 * targets. Whole-project scans derive the root sentinel '.'; malformed
 * shapes derive no paths (the schema layer rejects them independently and
 * the capability gate fail-closes on a missing path for constrained
 * tokens).
 */
function deriveEngineTargetPaths(
  method: string,
  raw: Record<string, unknown>,
): string[] {
  if (method === 'findSyntaxNode') {
    const file = stringField(raw, 'file');
    return file !== null ? [file] : [];
  }
  if (method === 'searchSymbols') {
    const files = raw['files'];
    if (!Array.isArray(files)) return ['.'];
    return dedupe(files.filter((file): file is string => typeof file === 'string'));
  }
  if (method === 'describeProject' || method === 'getRelevantTests') {
    return ['.'];
  }
  // Semantic ops: corpus-wide retrieval/indexing/clearing derives the root
  // sentinel; overlay refresh derives the touched files it names.
  if (
    method === 'semanticSearch' ||
    method === 'indexSemanticCorpus' ||
    method === 'clearSemanticOverlay'
  ) {
    return ['.'];
  }
  if (method === 'refreshSemanticOverlay') {
    const touched = raw['touchedFiles'];
    if (!Array.isArray(touched)) return ['.'];
    return dedupe(touched.filter((file): file is string => typeof file === 'string'));
  }
  // seeCodebase — one path per target.
  const targets = raw['targets'];
  if (!Array.isArray(targets)) return [];
  const paths: string[] = [];
  for (const target of targets) {
    paths.push(...pathsForSeeCodebaseTarget(target));
  }
  return dedupe(paths);
}

function pathsForSeeCodebaseTarget(target: unknown): string[] {
  if (typeof target !== 'object' || target === null) return [];
  const raw = target as Record<string, unknown>;
  if (raw['kind'] === 'file' && typeof raw['path'] === 'string') {
    return [raw['path']];
  }
  if (raw['kind'] === 'ast_node' && typeof raw['file'] === 'string') {
    return [raw['file']];
  }
  if (raw['kind'] === 'symbol') {
    return typeof raw['file'] === 'string' ? [raw['file']] : ['.'];
  }
  if (raw['kind'] === 'project') return ['.'];
  if (raw['kind'] === 'pattern') {
    const scope = raw['scope'];
    if (!Array.isArray(scope)) return ['.'];
    return scope.filter((path): path is string => typeof path === 'string');
  }
  return [];
}

function dedupe(paths: readonly string[]): string[] {
  return [...new Set(paths)];
}

export function strictCapabilityFromBody(
  raw: Record<string, unknown>,
  correlationId: string,
): StrictEngagementCheck['capability'] | undefined {
  const input = raw['capability'];
  if (input === undefined) return undefined;
  if (typeof input !== 'object' || input === null) {
    throw invalidContext(correlationId);
  }
  const value = input as Record<string, unknown>;
  const key = capabilityKey(value['key'] ?? value['capability']);
  const branch = stringValue(value['branch']);
  const path = stringValue(value['path']);
  if (key === null || branch === null || path === null) {
    throw invalidContext(correlationId);
  }
  const astNodeIds = stringArray(value['astNodeIds'], correlationId);
  const astSelectors = stringArray(value['astSelectors'], correlationId);
  const sessionId = stringValue(value['sessionId']);
  const taskId = stringValue(value['taskId']);
  return {
    key,
    branch,
    path,
    ...(astNodeIds !== undefined ? { astNodeIds } : {}),
    ...(astSelectors !== undefined ? { astSelectors } : {}),
    ...(sessionId !== null ? { sessionId } : {}),
    ...(taskId !== null ? { taskId } : {}),
  };
}

function parseEngagementContext(
  rawEngagement: unknown,
  correlationId: string,
): StrictEngagementCheck['engagement'] {
  if (rawEngagement === undefined) return undefined;
  const parsed = StrictEngagementContextSchema.safeParse(rawEngagement);
  if (parsed.success) return parsed.data;
  throw invalidContext(correlationId);
}

function invalidContext(correlationId: string): StrictEngagementError {
  return new StrictEngagementError({
    kind: 'engagement_invalid_context',
    correlationId,
    statusCode: 400,
  });
}

function isStrictEngineMethod(method: string): boolean {
  return (
    method === 'seeCodebase' ||
    method === 'searchSymbols' ||
    method === 'findSyntaxNode' ||
    method === 'describeProject' ||
    method === 'getRelevantTests' ||
    isStrictSemanticEngineMethod(method)
  );
}

/**
 * Critical-review fix (strict semantic bypass): the four semantic
 * operations are strict engine methods — the strict allowlist keeps them
 * available to strict agents, but only behind the same audited engagement
 * gate the read/search ops use.
 */
export function isStrictSemanticEngineMethod(method: string): boolean {
  return (
    method === 'semanticSearch' ||
    method === 'indexSemanticCorpus' ||
    method === 'refreshSemanticOverlay' ||
    method === 'clearSemanticOverlay'
  );
}

/**
 * Fail-closed guard for strict semantic ops. Unlike the strict read/search
 * contracts, the semantic request contracts keep `runId`/`engagement`
 * optional for default-profile compatibility, so a body missing the strict
 * context passes schema validation and `strictEngineCheckFromBody` returns
 * null. Strict wrappers call this when the gate is active and the check is
 * null: a semantic method without the full strict context is denied here
 * instead of dispatching ungated. Non-semantic methods are a no-op — their
 * schemas already require the strict identifiers.
 */
export function assertStrictSemanticEngineContext(
  method: string,
  body: unknown,
): void {
  if (!isStrictSemanticEngineMethod(method)) return;
  const raw =
    typeof body === 'object' && body !== null
      ? (body as Record<string, unknown>)
      : {};
  const projectId = stringField(raw, 'projectId');
  const runId = stringField(raw, 'runId');
  const correlationId = stringField(raw, 'correlationId');
  if (projectId !== null && runId !== null && correlationId !== null) return;
  throw invalidContext(correlationId ?? 'unknown');
}

function actionForEngineMethod(
  method: string,
  body: Record<string, unknown>,
): GatedAction {
  if (method === 'searchSymbols' || method === 'semanticSearch') return 'search';
  if (method !== 'seeCodebase') return 'read';
  const intent = body['intent'];
  return intent === 'find_symbol' || intent === 'search_exact_text'
    ? 'search'
    : 'read';
}

function capabilityKey(
  value: unknown,
): NonNullable<StrictEngagementCheck['capability']>['key'] | null {
  return value === 'read' ||
    value === 'search' ||
    value === 'write' ||
    value === 'lock' ||
    value === 'snapshot'
    ? value
    : null;
}

function stringField(raw: Record<string, unknown>, key: string): string | null {
  return stringValue(raw[key]);
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null;
}

function stringArray(
  value: unknown,
  correlationId: string,
): string[] | undefined {
  if (value === undefined) return undefined;
  if (!Array.isArray(value)) throw invalidContext(correlationId);
  if (!value.every((entry) => typeof entry === 'string' && entry.length > 0)) {
    throw invalidContext(correlationId);
  }
  return value;
}
