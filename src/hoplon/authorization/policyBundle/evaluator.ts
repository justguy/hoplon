/**
 * authorization/policyBundle/evaluator.ts — in-process equivalent of the
 * reference Rego policy at `policy/hoplon_authz.rego` (T-149, Strategy A).
 *
 * STATUS: ADVISORY / FIXTURE-ONLY.
 *
 *   This evaluator is consumed by `BundledOpaClient` so the deterministic
 *   kernel can exercise `OpaAuthorizationAdapter` end-to-end without a real
 *   OPA sidecar. Production deployments load the Rego policy into a real
 *   OPA sidecar; this file is a hermetic test harness.
 *
 *   This evaluator and `policy/hoplon_authz.rego` MUST stay in lockstep.
 *   Any change to one MUST be mirrored in the other; the corpus tests
 *   under `tests/policy/opaPolicyBundle.test.ts` exercise the evaluator
 *   against the documented semantics so divergence surfaces immediately.
 *
 * Layer order (top wins; explicit deny wins):
 *
 *   1. Global hard deny.            → deny       (fixture currently empty)
 *   2. Sensitive path restrictions. → security_approval | deny
 *   3. Project policy.              → allow | requires_escalation
 *   4. Branch policy.               → requires_human_approval (overrides 3)
 *   5. Active escalation grants.    → allow (escalation_grant)
 *   6. Default deny.                → deny
 *
 * Architecture rules:
 *   - Pure function (modulo the injected `decisionIdSeed`). No fs, no
 *     network, no clock, no randomness.
 *   - Output shape strictly matches what `normalizeOpaDecision` accepts.
 *   - Named exports only. TypeScript strict. No `any`.
 */
import type { PolicyData } from './types.js';
import {
  branchDisposition,
  bundledRequestCapabilities,
  grantCapabilities,
  matchActiveGrants,
  matchGlobalDeny,
  matchSensitivePath,
  projectDisposition,
  requestedScopeObject,
  standingPolicyCapabilities,
} from './evaluatorHelpers.js';
import type { BundleOpaInput, EvaluatorDeps } from './evaluatorTypes.js';

export { BUNDLE_CAPABILITY_KEYS } from './evaluatorTypes.js';
export type {
  BundleCapabilityKey,
  BundleOpaInput,
  EvaluatorDeps,
} from './evaluatorTypes.js';

/**
 * Capability keys this bundle understands. Matches `TokenCapabilities`.
 *
 * `snapshot` is a first-class capability and must be evaluated through
 * the same layers (global deny → sensitive paths → project → branch →
 * grants → default deny) as `read`/`search`/`write`/`lock`. Dropping
 * snapshot from this constant — or skipping it in the evaluator while
 * accepting it in the input — is the silent-capability-drop bug T-149's
 * review fix closes; do not narrow this list without also widening
 * `TokenCapabilities`.
 */
/**
 * Evaluate a request against the policy bundle. Returns the raw decision
 * payload in the shape expected by `normalizeOpaDecision`. Never throws.
 */
export function evaluatePolicyBundle(
  policy: PolicyData,
  input: BundleOpaInput,
  deps: EvaluatorDeps,
): Record<string, unknown> {
  const decisionId = deps.generateDecisionId();
  const policyVersion = policy.policyVersion;

  // Layer 1: explicit global deny wins everything else.
  const globalDeny = matchGlobalDeny(policy, input);
  if (globalDeny !== null) {
    return {
      outcome: 'deny',
      reason: `global_hard_deny:${globalDeny}`,
      decisionId,
      policyVersion,
    };
  }

  // Layer 2: sensitive path restrictions. Evaluated BEFORE project allow
  // so a project-A blanket allow does not let writes touch `secrets/**`.
  const sensitive = matchSensitivePath(policy, input);
  if (sensitive !== null) {
    if (sensitive.disposition === 'deny') {
      return {
        outcome: 'deny',
        reason: `sensitive_path_deny:${sensitive.pattern}`,
        decisionId,
        policyVersion,
      };
    }
    return {
      outcome: 'requires_approval',
      escalationKind: 'security_approval',
      requestedScope: requestedScopeObject(input),
      reason: `sensitive_path:${sensitive.pattern}`,
      decisionId,
      policyVersion,
    };
  }

  const project = policy.projects[input.request.projectId];
  if (project === undefined) {
    return {
      outcome: 'deny',
      reason: `default_deny_unknown_project:${input.request.projectId}`,
      decisionId,
      policyVersion,
    };
  }

  // Layer 3 + 4: project + branch policy combined disposition.
  const requestedCaps = bundledRequestCapabilities(input.request.capabilities);
  if (requestedCaps.length === 0) {
    return {
      outcome: 'deny',
      reason: 'default_deny_no_supported_capabilities',
      decisionId,
      policyVersion,
    };
  }

  const dispositions = requestedCaps.map((cap) => ({
    cap,
    project: projectDisposition(project, cap),
    branch: branchDisposition(policy, input.request.projectId, input.request.branch, cap),
  }));

  // Layer 4 has the highest non-deny precedence: protected-branch human
  // approval supersedes project allow AND escalation grants. (`main` and
  // `release/*` write/lock fall here; the agent must surface a human
  // approval flow.)
  if (dispositions.some((d) => d.branch === 'requires_human_approval')) {
    return {
      outcome: 'requires_approval',
      escalationKind: 'human_approval',
      requestedScope: requestedScopeObject(input),
      reason: 'protected_branch',
      decisionId,
      policyVersion,
    };
  }

  // Layer 3: standing allow — every requested capability must be `allow`
  // both at project default and branch override (where one exists).
  const allAllowed = dispositions.every(
    (d) => d.project === 'allow' && (d.branch === 'allow'),
  );
  if (allAllowed) {
    return {
      outcome: 'allow',
      source: 'standing_policy',
      capabilities: standingPolicyCapabilities(requestedCaps, input),
      expiresInSeconds: project.token.maxTtlSeconds,
      decisionId,
      policyVersion,
    };
  }

  // Layer 5: active grant satisfies the escalation requirement?
  // A request needs grant coverage iff project disposition for at least
  // one requested capability is `requires_escalation`. Branch
  // `requires_escalation` would also fall here (none in current fixture).
  const needsEscalation = dispositions.some(
    (d) => d.project === 'requires_escalation' || d.branch === 'requires_escalation',
  );
  if (needsEscalation) {
    const matched = matchActiveGrants(policy, input, requestedCaps);
    if (matched.length > 0) {
      return {
        outcome: 'allow',
        source: 'escalation_grant',
        capabilities: grantCapabilities(matched, requestedCaps, input),
        expiresInSeconds: policy.grantExpiresInSeconds,
        grantIds: matched.map((g) => g.grantId),
        decisionId,
        policyVersion,
      };
    }
    return {
      outcome: 'requires_escalation',
      escalationKind: 'cto_approval',
      requestedScope: requestedScopeObject(input),
      reason: 'project_policy_requires_escalation',
      decisionId,
      policyVersion,
    };
  }

  // Layer 6: default deny.
  return {
    outcome: 'deny',
    reason: 'default_deny_no_rule_matched',
    decisionId,
    policyVersion,
  };
}
