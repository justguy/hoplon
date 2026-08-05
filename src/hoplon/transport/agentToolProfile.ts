export type AgentToolProfile = 'default' | 'strict_agent';

export const DEFAULT_AGENT_TOOL_PROFILE: AgentToolProfile = 'default';
export const STRICT_AGENT_TOOL_PROFILE: AgentToolProfile = 'strict_agent';

const STRICT_MCP_TOOL_NAMES = new Set<string>([
  'describe_capabilities',
  'describe_project',
  'get_relevant_tests',
  'health',
  'find_syntax_node',
  'projects_handshake',
  'projects_policy_audit',
  'projects_policy_summary',
  'projects_prune',
  'projects_renew',
  'projects_revoke',
  'search_symbols',
  'see_codebase',
  // Semantic ops stay in the strict profile deliberately (allow-with-
  // engagement): dispatch is gated by the strict engagement gate + file
  // policy, not by this allowlist — see transport/strictEngagementCheck.ts.
  'index_semantic_corpus',
  'semantic_search',
  'refresh_semantic_overlay',
  'clear_semantic_overlay',
  'session_apply_edits',
  'session_audit',
  'session_close',
  'session_create_snapshot',
  'session_dry_run',
  'session_extract_rollback_template',
  'session_get_closeout_proof_bundle',
  'session_get_repair_context',
  'session_inspect',
  'session_list',
  'session_preflight',
  'session_revert',
  'session_review',
  'session_stage_content',
  'session_target_first_scoped_edit',
  'session_verify_behavior',
  'start_edit_session',
]);

const STRICT_HTTP_ENGINE_METHODS = new Set<string>([
  'describeCapabilities',
  'describeProject',
  'getRelevantTests',
  'health',
  'indexSemanticCorpus',
  'semanticSearch',
  'refreshSemanticOverlay',
  'clearSemanticOverlay',
  'searchSymbols',
  'seeCodebase',
]);

const STRICT_HTTP_SESSION_OPS = new Set<HttpSessionOp>([
  'start',
  'preflight',
  'createSnapshot',
  'dryRun',
  'applyEdits',
  'stageContent',
  'audit',
  'revert',
  'extractRollbackTemplate',
  'getCloseoutProofBundle',
  'getRepairContext',
  'review',
  'verifyBehavior',
  'inspect',
  'close',
  'list',
  'snapshotEvidence',
  'targetFirstScopedEdit',
]);

const STRICT_HTTP_PROJECT_OPS = new Set<HttpProjectOp>([
  'handshake',
  'policySummary',
  'policyAudit',
  'renew',
  'revoke',
  'prune',
]);

export type HttpSessionOp =
  | 'start'
  | 'preflight'
  | 'createSnapshot'
  | 'dryRun'
  | 'applyEdits'
  | 'stageContent'
  | 'markEdited'
  | 'audit'
  | 'revert'
  | 'extractRollbackTemplate'
  | 'getCloseoutProofBundle'
  | 'getRepairContext'
  | 'review'
  | 'verifyBehavior'
  | 'inspect'
  | 'close'
  | 'list'
  | 'quickEdit'
  | 'snapshotEvidence'
  | 'targetFirstScopedEdit';

export type HttpProjectOp =
  | 'list'
  | 'register'
  | 'unregister'
  | 'select'
  | 'clearActive'
  | 'handshake'
  | 'policySummary'
  | 'policyAudit'
  | 'renew'
  | 'revoke'
  | 'prune';

export function normalizeAgentToolProfile(
  profile: AgentToolProfile | undefined,
): AgentToolProfile {
  return profile ?? DEFAULT_AGENT_TOOL_PROFILE;
}

export function parseAgentToolProfileFlag(
  raw: string | undefined,
): AgentToolProfile | null {
  if (raw === undefined || raw === 'default') {
    return DEFAULT_AGENT_TOOL_PROFILE;
  }
  if (raw === 'strict-agent' || raw === STRICT_AGENT_TOOL_PROFILE) {
    return STRICT_AGENT_TOOL_PROFILE;
  }
  return null;
}

export function isMcpToolAllowedForAgentProfile(
  profile: AgentToolProfile | undefined,
  name: string,
): boolean {
  if (normalizeAgentToolProfile(profile) === DEFAULT_AGENT_TOOL_PROFILE) {
    return true;
  }
  return STRICT_MCP_TOOL_NAMES.has(name);
}

export function filterMcpToolsForAgentProfile<T extends { name: string }>(
  tools: readonly T[],
  profile: AgentToolProfile | undefined,
): T[] {
  return tools.filter((tool) =>
    isMcpToolAllowedForAgentProfile(profile, tool.name),
  );
}

export function isHttpEngineMethodAllowedForAgentProfile(
  profile: AgentToolProfile | undefined,
  method: string,
): boolean {
  if (normalizeAgentToolProfile(profile) === DEFAULT_AGENT_TOOL_PROFILE) {
    return true;
  }
  return STRICT_HTTP_ENGINE_METHODS.has(method);
}

export function isHttpSessionOpAllowedForAgentProfile(
  profile: AgentToolProfile | undefined,
  op: HttpSessionOp,
): boolean {
  if (normalizeAgentToolProfile(profile) === DEFAULT_AGENT_TOOL_PROFILE) {
    return true;
  }
  return STRICT_HTTP_SESSION_OPS.has(op);
}

export function isHttpProjectOpAllowedForAgentProfile(
  profile: AgentToolProfile | undefined,
  op: HttpProjectOp,
): boolean {
  if (normalizeAgentToolProfile(profile) === DEFAULT_AGENT_TOOL_PROFILE) {
    return true;
  }
  return STRICT_HTTP_PROJECT_OPS.has(op);
}

export {
  HOPLON_STRICT_AGENT_FALLBACK_POLICY,
  STRICT_AGENT_FORBIDDEN_FALLBACKS,
  strictAgentFallbackEnvelope,
  strictAgentFallbackHttpResponse,
  strictAgentHiddenHttpSurface,
} from './strictAgentFallback.js';
export type {
  StrictAgentFallbackErrorEnvelope,
  StrictAgentFallbackErrorKind,
  StrictAgentFallbackPolicy,
  StrictAgentForbiddenFallback,
} from './strictAgentFallback.js';
