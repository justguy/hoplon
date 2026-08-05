import { z } from 'zod';

export const RBAA_SCHEMA_VERSIONS = [1] as const;
export const RBAA_RISK_BANDS = [
  'R0_LOW', 'R1_GUARDED', 'R2_ESCALATE',
  'R3_APPROVAL', 'R4_QUARANTINE_OR_DENY',
] as const;
export const RBAA_AUTONOMY_TIERS = [
  'A0_OBSERVER', 'A1_PROPOSER', 'A2_SCOPED_EDITOR',
  'A3_MULTI_FILE_EDITOR', 'A4_PROTECTED_OPERATOR', 'A5_BREAK_GLASS',
] as const;
export const RBAA_RUNTIME_CONTROLS = [
  'propose_only', 'short_ttl', 'narrow_path_scope',
  'ast_scope_required', 'max_edit_operations', 'max_files_touched',
  'test_gate_required', 'human_review_required', 'security_review_required',
  'enhanced_audit', 'quarantine_required',
] as const;
export const RBAA_CAPABILITY_KEYS = ['read', 'search', 'write', 'lock', 'snapshot'] as const;

export const RbaaSchemaVersionSchema = z.literal(1);
export type RbaaSchemaVersion = z.infer<typeof RbaaSchemaVersionSchema>;

export const RbaaRiskBandSchema = z.enum(RBAA_RISK_BANDS);
export type RbaaRiskBand = z.infer<typeof RbaaRiskBandSchema>;

export const RbaaAutonomyTierSchema = z.enum(RBAA_AUTONOMY_TIERS);
export type RbaaAutonomyTier = z.infer<typeof RbaaAutonomyTierSchema>;

export const RbaaRuntimeControlSchema = z.enum(RBAA_RUNTIME_CONTROLS);
export type RbaaRuntimeControl = z.infer<typeof RbaaRuntimeControlSchema>;

export const RbaaCapabilityKeySchema = z.enum(RBAA_CAPABILITY_KEYS);
export type RbaaCapabilityKey = z.infer<typeof RbaaCapabilityKeySchema>;

export const RbaaRelativePathPatternSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.startsWith('/'), 'path scope must be project-relative')
  .refine(
    (p) => !/^[A-Za-z]:[/\\]/.test(p),
    'path scope must not be Windows absolute',
  )
  .refine(
    (p) => !p.split(/[/\\]/).some((seg) => seg === '..'),
    'path scope must not contain .. segments',
  );
export type RbaaRelativePathPattern =
  z.infer<typeof RbaaRelativePathPatternSchema>;

export const RbaaPrincipalSchema = z
  .object({
    id: z.string().min(1),
    type: z.enum(['agent', 'human', 'service']),
    roles: z.array(z.string().min(1)).max(50),
    trustTier: z.string().min(1).optional(),
    modelProfile: z.string().min(1).optional(),
    identityAssurance: z.enum(['unknown', 'low', 'medium', 'high']).optional(),
  })
  .strict();
export type RbaaPrincipal = z.infer<typeof RbaaPrincipalSchema>;

export const RbaaTaskContextSchema = z
  .object({
    id: z.string().min(1),
    workPackageId: z.string().min(1).optional(),
    type: z.string().min(1).optional(),
    missionPriority: z.enum(['low', 'normal', 'high', 'critical']).optional(),
    delegationChain: z.array(z.string().min(1)).max(25).optional(),
  })
  .strict();
export type RbaaTaskContext = z.infer<typeof RbaaTaskContextSchema>;

export const RbaaScopeClaimSchema = z
  .object({
    paths: z.array(RbaaRelativePathPatternSchema).min(1).max(1000),
    branches: z.array(z.string().min(1)).min(1).max(100),
    deniedPaths: z.array(RbaaRelativePathPatternSchema).max(1000).optional(),
    astNodeIds: z.array(z.string().min(1)).max(1000).optional(),
    astSelectors: z.array(z.string().min(1)).max(1000).optional(),
    maxOperations: z.number().int().positive().optional(),
    maxFilesTouched: z.number().int().positive().optional(),
  })
  .strict();
export type RbaaScopeClaim = z.infer<typeof RbaaScopeClaimSchema>;

const RbaaCapabilityMapBaseSchema = z
  .object({
    read: RbaaScopeClaimSchema.optional(),
    search: RbaaScopeClaimSchema.optional(),
    write: RbaaScopeClaimSchema.optional(),
    lock: RbaaScopeClaimSchema.optional(),
    snapshot: RbaaScopeClaimSchema.optional(),
  })
  .strict();

export const RbaaTokenCapabilitiesSchema = RbaaCapabilityMapBaseSchema.superRefine(
  (value, ctx) => {
    if (!Object.values(value).some((claim) => claim !== undefined)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'at least one capability scope is required',
      });
    }
  },
);
export type RbaaTokenCapabilities = z.infer<typeof RbaaTokenCapabilitiesSchema>;

export const RbaaUsageLimitsSchema = z
  .object({
    expiresInSeconds: z.number().int().positive().max(86_400),
    maxOperations: z.number().int().positive().optional(),
    maxFilesTouched: z.number().int().positive().optional(),
  })
  .strict();
export type RbaaUsageLimits = z.infer<typeof RbaaUsageLimitsSchema>;

export const RbaaRiskFactorSchema = z
  .object({
    id: z.string().min(1),
    source: z.enum(['control_plane', 'phalanx', 'hoplon', 'policy_engine', 'platform']),
    label: z.string().min(1),
    severity: z.enum(['info', 'low', 'medium', 'high', 'critical']),
    evidenceRef: z.string().min(1).optional(),
  })
  .strict();
export type RbaaRiskFactor = z.infer<typeof RbaaRiskFactorSchema>;

export const RbaaRiskFactsSchema = z
  .object({
    projectId: z.string().min(1),
    branch: z.string().min(1),
    sessionId: z.string().min(1),
    evaluatedAt: z.string().datetime(),
    facts: z.array(RbaaRiskFactorSchema).min(1).max(100),
  })
  .strict();
export type RbaaRiskFacts = z.infer<typeof RbaaRiskFactsSchema>;

export const RbaaRiskPostureSchema = z
  .object({
    evaluationId: z.string().min(1),
    band: RbaaRiskBandSchema,
    scoreBucket: z.enum(['0-19', '20-39', '40-59', '60-79', '80-100']),
    autonomyTier: RbaaAutonomyTierSchema,
    controls: z.array(RbaaRuntimeControlSchema).max(25),
    topFactors: z.array(RbaaRiskFactorSchema).max(10),
  })
  .strict();
export type RbaaRiskPosture = z.infer<typeof RbaaRiskPostureSchema>;

export const RbaaActiveGrantSchema = z
  .object({
    grantId: z.string().min(1),
    principalId: z.string().min(1),
    projectId: z.string().min(1),
    taskId: z.string().min(1),
    capabilities: RbaaTokenCapabilitiesSchema,
    grantedBy: z.string().min(1),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
    revokedAt: z.string().datetime().optional(),
  })
  .strict();
export type RbaaActiveGrant = z.infer<typeof RbaaActiveGrantSchema>;

const RbaaRequestedOperationSchema = z
  .object({
    projectId: z.string().min(1),
    branch: z.string().min(1),
    capabilities: z.array(RbaaCapabilityKeySchema).min(1).max(5),
    paths: z.array(RbaaRelativePathPatternSchema).max(1000).optional(),
    astSelectors: z.array(z.string().min(1)).max(1000).optional(),
    astNodeIds: z.array(z.string().min(1)).max(1000).optional(),
    reason: z.string().min(1).optional(),
  })
  .strict();

const RbaaRequestContextSchema = z
  .object({
    sessionId: z.string().min(1),
    environment: z.enum(['dev', 'staging', 'prod']),
    now: z.string().datetime(),
  })
  .strict();

export const RbaaAuthorizationRequestSchema = z
  .object({
    schemaVersion: RbaaSchemaVersionSchema,
    principal: RbaaPrincipalSchema,
    task: RbaaTaskContextSchema,
    request: RbaaRequestedOperationSchema,
    context: RbaaRequestContextSchema,
    riskFacts: RbaaRiskFactsSchema,
    activeGrants: z.array(RbaaActiveGrantSchema).max(100).optional(),
  })
  .strict();
export type RbaaAuthorizationRequest = z.infer<typeof RbaaAuthorizationRequestSchema>;

const RbaaDecisionBaseSchema = z
  .object({
    schemaVersion: RbaaSchemaVersionSchema,
    decisionId: z.string().min(1),
    policyVersion: z.string().min(1),
    risk: RbaaRiskPostureSchema,
  })
  .strict();

export const RbaaAuthorizationDecisionSchema = z.discriminatedUnion('outcome', [
  RbaaDecisionBaseSchema.extend({
    outcome: z.literal('allow'),
    source: z.enum(['standing_policy', 'escalation_grant', 'risk_adjusted', 'break_glass']),
    capabilities: RbaaTokenCapabilitiesSchema,
    limits: RbaaUsageLimitsSchema,
    grantIds: z.array(z.string().min(1)).max(50).optional(),
  }).strict(),
  RbaaDecisionBaseSchema.extend({
    outcome: z.enum(['requires_escalation', 'requires_approval']),
    escalationKind: z.enum([
      'self_service',
      'cto_approval',
      'human_approval',
      'security_approval',
      'platform_approval',
      'dba_approval',
    ]),
    requestedScope: RbaaTokenCapabilitiesSchema,
    requiredControls: z.array(RbaaRuntimeControlSchema).min(1).max(25),
    reason: z.string().min(1),
  }).strict(),
  RbaaDecisionBaseSchema.extend({
    outcome: z.enum(['quarantine', 'deny']),
    reason: z.string().min(1),
  }).strict(),
]);
export type RbaaAuthorizationDecision = z.infer<typeof RbaaAuthorizationDecisionSchema>;

export const RbaaEngagementTokenClaimsSchema = z
  .object({
    schemaVersion: RbaaSchemaVersionSchema,
    tokenId: z.string().min(1),
    subject: RbaaPrincipalSchema,
    projectId: z.string().min(1),
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    capabilities: RbaaTokenCapabilitiesSchema,
    limits: RbaaUsageLimitsSchema,
    risk: RbaaRiskPostureSchema,
    policy: z
      .object({
        engine: z.enum(['static', 'opa', 'control_plane']),
        decisionId: z.string().min(1),
        policyVersion: z.string().min(1),
        grantIds: z.array(z.string().min(1)).max(50).optional(),
      })
      .strict(),
    issuedAt: z.string().datetime(),
    expiresAt: z.string().datetime(),
  })
  .strict();
export type RbaaEngagementTokenClaims = z.infer<typeof RbaaEngagementTokenClaimsSchema>;

export const RbaaPolicyAuditEvidenceSchema = z
  .object({
    schemaVersion: RbaaSchemaVersionSchema,
    sessionId: z.string().min(1),
    taskId: z.string().min(1),
    workPackageId: z.string().min(1).optional(),
    decisionId: z.string().min(1),
    policyVersion: z.string().min(1),
    tokenId: z.string().min(1).optional(),
    operationId: z.string().min(1).optional(),
    grantIds: z.array(z.string().min(1)).max(50).optional(),
    limits: RbaaUsageLimitsSchema,
    riskEvaluationId: z.string().min(1),
    riskBand: RbaaRiskBandSchema,
    autonomyTier: RbaaAutonomyTierSchema,
    runtimeControls: z.array(RbaaRuntimeControlSchema).max(25),
    outcome: z.enum([
      'allow',
      'requires_escalation',
      'requires_approval',
      'quarantine',
      'deny',
    ]),
    recordedAt: z.string().datetime(),
  })
  .strict();
export type RbaaPolicyAuditEvidence = z.infer<typeof RbaaPolicyAuditEvidenceSchema>;
