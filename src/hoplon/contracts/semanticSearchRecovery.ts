import { z } from 'zod';

import { ValidationError } from './errors.js';

export const SemanticSearchBranchScopeModeSchema = z.enum([
  'current',
  'default',
  'all_indexed',
  'all_local_branches',
  'all_remote_tracking_branches',
  'branches',
  'patterns',
]);
export type SemanticSearchBranchScopeMode = z.infer<
  typeof SemanticSearchBranchScopeModeSchema
>;

export const SemanticSearchBranchScopeSchema = z
  .object({
    mode: SemanticSearchBranchScopeModeSchema,
    refs: z.array(z.string().min(1)).optional(),
    patterns: z.array(z.string().min(1)).optional(),
  })
  .strict()
  .superRefine((scope, ctx) => {
    if (scope.mode === 'branches' && (scope.refs?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['refs'],
        message: 'branchScope.mode=branches requires at least one ref',
      });
    }
    if (scope.mode === 'patterns' && (scope.patterns?.length ?? 0) === 0) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['patterns'],
        message: 'branchScope.mode=patterns requires at least one pattern',
      });
    }
  });
export type SemanticSearchBranchScope = z.infer<
  typeof SemanticSearchBranchScopeSchema
>;

export const SemanticSearchStalePolicySchema = z.enum([
  'include_with_warning',
  'exclude',
  'refresh_before_search',
]);
export type SemanticSearchStalePolicy = z.infer<
  typeof SemanticSearchStalePolicySchema
>;

export const SemanticSearchSuggestionModeSchema = z.enum([
  'off',
  'deterministic',
  'semantic',
  'deterministic_then_semantic',
]);
export type SemanticSearchSuggestionMode = z.infer<
  typeof SemanticSearchSuggestionModeSchema
>;

export const SemanticSearchRecoveryDiagnosticSchema = z.object({
  fieldPath: z.string().min(1),
  code: z.string().min(1),
  message: z.string().min(1),
  expectedShape: z.string().min(1),
  allowedValues: z.array(z.string().min(1)).optional(),
  didYouMean: z.string().min(1).optional(),
});
export type SemanticSearchRecoveryDiagnostic = z.infer<
  typeof SemanticSearchRecoveryDiagnosticSchema
>;

export const SemanticSearchRecoveryEnvelopeSchema = z.object({
  error: z.literal(true),
  kind: z.literal('invalid_semantic_search_request'),
  advisory: z.literal(true),
  tool: z.literal('semanticSearch'),
  diagnostics: z.array(SemanticSearchRecoveryDiagnosticSchema).min(1),
  minimalValidRequest: z.object({
    correlationId: z.string().min(1),
    projectId: z.string().min(1),
    query: z.string().min(1),
    topK: z.number().int().positive(),
  }),
  requestShape: z.object({
    required: z.array(z.string().min(1)),
    optional: z.array(z.string().min(1)),
  }),
});
export type SemanticSearchRecoveryEnvelope = z.infer<
  typeof SemanticSearchRecoveryEnvelopeSchema
>;

const REQUIRED_FIELDS = ['correlationId', 'projectId', 'query', 'topK'];
const OPTIONAL_FIELDS = [
  'currentContext',
  'indexedContext',
  'allowStale',
  'allowDegraded',
  'sessionId',
  'freshness',
  'overlayScope',
  'branchScope',
  'stalePolicy',
  'resultFields',
  'suggestionMode',
];
const KNOWN_FIELDS = [...REQUIRED_FIELDS, ...OPTIONAL_FIELDS];

const EXPECTED_BY_PATH: Readonly<Record<string, string>> = {
  correlationId: 'non-empty string',
  projectId: 'non-empty string',
  query: 'non-empty string',
  topK: 'positive integer',
  freshness: "'indexed' | 'live_session'",
  overlayScope: "'baseline_plus_session' | 'session_overlay_only'",
  resultFields: "'path_only' | 'path_and_symbol' | 'snippet'",
  stalePolicy: "'include_with_warning' | 'exclude' | 'refresh_before_search'",
  suggestionMode:
    "'off' | 'deterministic' | 'semantic' | 'deterministic_then_semantic'",
  branchScope: 'object with mode and optional refs/patterns',
  'branchScope.mode':
    "'current' | 'default' | 'all_indexed' | 'all_local_branches' | " +
    "'all_remote_tracking_branches' | 'branches' | 'patterns'",
  'branchScope.refs': 'non-empty string array when mode is branches',
  'branchScope.patterns': 'non-empty string array when mode is patterns',
};

const MINIMAL_REQUEST = {
  correlationId: 'corr-semantic-search',
  projectId: 'project-id',
  query: 'semantic search query',
  topK: 5,
};

export class SemanticSearchRequestValidationError extends ValidationError {
  readonly recovery: SemanticSearchRecoveryEnvelope;

  constructor(args: {
    engineId: string;
    correlationId: string;
    cause: z.ZodError;
  }) {
    const recovery = buildSemanticSearchRecoveryEnvelope(args.cause);
    super(
      {
        kind: 'invalid_scope',
        engineId: args.engineId,
        correlationId: args.correlationId,
        cause: args.cause,
      },
      `semanticSearch: invalid request: ${recovery.diagnostics[0]?.message ?? 'schema validation failed'}`,
    );
    this.name = 'SemanticSearchRequestValidationError';
    this.recovery = recovery;
  }
}

export function buildSemanticSearchRecoveryEnvelope(
  error: z.ZodError,
): SemanticSearchRecoveryEnvelope {
  const diagnostics = error.issues.flatMap(issueToDiagnostics);
  return {
    error: true,
    kind: 'invalid_semantic_search_request',
    advisory: true,
    tool: 'semanticSearch',
    diagnostics,
    minimalValidRequest: MINIMAL_REQUEST,
    requestShape: {
      required: REQUIRED_FIELDS,
      optional: OPTIONAL_FIELDS,
    },
  };
}

function issueToDiagnostics(issue: z.ZodIssue): SemanticSearchRecoveryDiagnostic[] {
  if (issue.code === z.ZodIssueCode.unrecognized_keys) {
    return issue.keys.map((key) => {
      const suggested = suggestField(key);
      return {
        fieldPath: key,
        code: issue.code,
        message: `Unsupported semanticSearch field '${key}'`,
        expectedShape: `one of: ${KNOWN_FIELDS.join(', ')}`,
        ...(suggested !== undefined ? { didYouMean: suggested } : {}),
      };
    });
  }
  return [singleIssueDiagnostic(issue)];
}

function singleIssueDiagnostic(issue: z.ZodIssue): SemanticSearchRecoveryDiagnostic {
  const fieldPath = issue.path.length === 0 ? '<root>' : issue.path.join('.');
  const allowedValues =
    issue.code === z.ZodIssueCode.invalid_enum_value
      ? issue.options.map((value) => String(value))
      : undefined;
  return {
    fieldPath,
    code: issue.code,
    message: classifyMessage(issue, fieldPath),
    expectedShape: expectedShape(fieldPath),
    ...(allowedValues !== undefined ? { allowedValues } : {}),
  };
}

function classifyMessage(issue: z.ZodIssue, fieldPath: string): string {
  if (
    issue.code === z.ZodIssueCode.invalid_type &&
    issue.received === 'undefined'
  ) {
    return `Missing required semanticSearch field '${fieldPath}'`;
  }
  return issue.message;
}

function expectedShape(fieldPath: string): string {
  return EXPECTED_BY_PATH[fieldPath] ?? 'valid SemanticSearchRequest field shape';
}

function suggestField(input: string): string | undefined {
  const matches = KNOWN_FIELDS.filter((field) => isOneEditOrTranspose(input, field));
  return matches.length === 1 ? matches[0] : undefined;
}

function isOneEditOrTranspose(left: string, right: string): boolean {
  if (left === right) return false;
  if (left.length === right.length) return isOneReplaceOrTranspose(left, right);
  if (Math.abs(left.length - right.length) !== 1) return false;
  const shorter = left.length < right.length ? left : right;
  const longer = left.length < right.length ? right : left;
  let skipped = false;
  for (let i = 0, j = 0; i < shorter.length; i += 1, j += 1) {
    if (shorter[i] === longer[j]) continue;
    if (skipped) return false;
    skipped = true;
    j += 1;
    if (shorter[i] !== longer[j]) return false;
  }
  return true;
}

function isOneReplaceOrTranspose(left: string, right: string): boolean {
  let firstDiff = -1;
  let diffCount = 0;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] === right[i]) continue;
    diffCount += 1;
    if (firstDiff === -1) firstDiff = i;
    if (diffCount > 2) return false;
  }
  if (diffCount === 1) return true;
  return (
    diffCount === 2 &&
    firstDiff + 1 < left.length &&
    left[firstDiff] === right[firstDiff + 1] &&
    left[firstDiff + 1] === right[firstDiff]
  );
}
