# hoplon_authz.rego — reference Rego policy for Hoplon dynamic authorization (T-149)
#
# STATUS: ADVISORY / FIXTURE-ONLY.
#
#   This file is a *reference implementation* of the Hoplon authorization
#   decision policy. It is not the production source of truth: per T-142 and
#   the T-149 brief, policy authoring lives in the Agentic OS / GitOps
#   publisher, which delivers the bundle to an OPA sidecar adjacent to
#   Hoplon. Hoplon itself does not load this Rego file at runtime.
#
#   The deterministic kernel exercises `OpaAuthorizationAdapter` end-to-end
#   against the *in-process equivalent* of this policy, implemented in
#   TypeScript at `src/hoplon/authorization/policyBundle/evaluator.ts`. That
#   evaluator and this Rego file MUST stay in lockstep — every change to one
#   must be mirrored in the other, and the corpus tests under
#   `tests/policy/opaPolicyBundle.test.ts` exercise the in-process evaluator
#   against the documented semantics so divergence surfaces immediately.
#
#   See `policy/README.md` for the sidecar deployment runbook.
#
# LAYER ORDER (evaluated top-to-bottom; explicit deny wins):
#
#   1. Global hard deny.            (`globalDenies` — currently empty in fixture data)
#   2. Sensitive path restrictions. (e.g. `secrets/**`, `.env*`)
#   3. Project policy.              (per-project default capability disposition)
#   4. Branch policy.               (e.g. `main`, `release/*`)
#   5. Active escalation grants.    (Control Plane–issued, time-bounded)
#   6. Default deny.                (no rule matched)
#
# CAPABILITIES (must match `BUNDLE_CAPABILITY_KEYS`):
#
#   read | search | write | lock | snapshot
#
#   `snapshot` is evaluated through the SAME layers in the SAME order as
#   `write`/`lock`. By default `snapshot` is treated as a write-class
#   capability for protected branches (`main`, `release/*`) and sensitive
#   paths (`secrets/**`, `.env*`) so creating a snapshot of a sensitive
#   path or a protected branch never silently widens access. Earlier
#   versions of this bundle silently dropped `snapshot` from the requested
#   capability set; the in-process evaluator and this Rego skeleton MUST
#   include `snapshot` in every layer that lists `write` or `lock`.
#
# OUTPUT SHAPE (must match `HoplonAuthorizationDecision` post-`normalizeOpaDecision`):
#
#   allow:  { outcome, source, capabilities, expiresInSeconds, decisionId, policyVersion, grantIds? }
#   esc:    { outcome:"requires_escalation", escalationKind, requestedScope, reason, decisionId, policyVersion }
#   apprv:  { outcome:"requires_approval",   escalationKind, requestedScope, reason, decisionId, policyVersion }
#   deny:   { outcome:"deny", reason, decisionId, policyVersion }
#
#   `source` for `allow`: `standing_policy` for project default; `escalation_grant`
#   for grant-allowed; `break_glass` is reserved (T-142 banned in default flow).
#   Capabilities map MUST contain concrete `paths` and `branches` arrays for each
#   granted key — vague roles are rejected by `normalizeOpaDecision`.

package hoplon.authz

import future.keywords.if
import future.keywords.in

# ─── 1. Global hard deny ──────────────────────────────────────────────────────
# Explicit deny wins over standing policy AND active grants. Returned first so
# nothing downstream can override.
decision := global_deny if {
  some entry in data.hoplon.policy.globalDenies
  glob_matches_request(entry, input)
}

global_deny := {
  "outcome": "deny",
  "reason": "global_hard_deny",
  "decisionId": new_decision_id,
  "policyVersion": data.hoplon.policy.policyVersion,
}

# ─── 2. Sensitive path restrictions ───────────────────────────────────────────
# Sensitive paths take precedence over project allows (e.g. project-a allows
# write/** but writes touching `secrets/**` still escalate to security).
decision := sensitive_path_outcome if {
  some path in input.request.paths
  some s in data.hoplon.policy.sensitivePaths
  matches_glob(path, s.pattern)
  cap := requested_sensitive_capability(s)
  cap != ""

  sensitive_path_outcome := build_sensitive_outcome(s, cap)
}

build_sensitive_outcome(s, cap) := out if {
  s[cap] == "requires_security_approval"
  out := {
    "outcome": "requires_approval",
    "escalationKind": "security_approval",
    "requestedScope": requested_scope_object,
    "reason": sprintf("sensitive_path:%v", [s.pattern]),
    "decisionId": new_decision_id,
    "policyVersion": data.hoplon.policy.policyVersion,
  }
}

build_sensitive_outcome(s, cap) := out if {
  s[cap] == "deny"
  out := {
    "outcome": "deny",
    "reason": sprintf("sensitive_path_deny:%v", [s.pattern]),
    "decisionId": new_decision_id,
    "policyVersion": data.hoplon.policy.policyVersion,
  }
}

# ─── 3 + 4. Project + branch policy (combined disposition) ────────────────────
# A request is allowed under standing policy only if EVERY requested capability
# is `allow` under the project default AND under the branch override (if any).
# Otherwise the strictest non-allow disposition is reported.
decision := standing_allow if {
  proj := data.hoplon.policy.projects[input.request.projectId]
  every cap in input.request.capabilities {
    project_disposition(proj, cap) == "allow"
    branch_disposition(input.request.projectId, input.request.branch, cap) == "allow"
  }
  standing_allow := {
    "outcome": "allow",
    "source": "standing_policy",
    "capabilities": project_full_capabilities,
    "expiresInSeconds": proj.token.maxTtlSeconds,
    "decisionId": new_decision_id,
    "policyVersion": data.hoplon.policy.policyVersion,
  }
}

decision := requires_human_approval_decision if {
  proj := data.hoplon.policy.projects[input.request.projectId]
  some cap in input.request.capabilities
  branch_disposition(input.request.projectId, input.request.branch, cap) == "requires_human_approval"
  requires_human_approval_decision := {
    "outcome": "requires_approval",
    "escalationKind": "human_approval",
    "requestedScope": requested_scope_object,
    "reason": "protected_branch",
    "decisionId": new_decision_id,
    "policyVersion": data.hoplon.policy.policyVersion,
  }
}

# ─── 5. Active escalation grants ──────────────────────────────────────────────
# Active grant matches if ALL of:
#   principalId == input.principal.id
#   taskId      == input.task.id
#   projectId   == input.request.projectId
#   expiresAt   >  context.now
#   grantId     not in revokedGrantIds
#   scope       ⊇  every requested capability path/branch
decision := grant_allow if {
  proj := data.hoplon.policy.projects[input.request.projectId]
  some cap in input.request.capabilities
  project_disposition(proj, cap) == "requires_escalation"
  matched := matching_active_grants
  count(matched) > 0

  grant_allow := {
    "outcome": "allow",
    "source": "escalation_grant",
    "capabilities": effective_grant_capabilities(matched),
    "expiresInSeconds": data.hoplon.policy.grantExpiresInSeconds,
    "grantIds": [g.grantId | some g in matched],
    "decisionId": new_decision_id,
    "policyVersion": data.hoplon.policy.policyVersion,
  }
}

# Project requires escalation; no matching grant → escalate.
decision := requires_escalation_decision if {
  proj := data.hoplon.policy.projects[input.request.projectId]
  some cap in input.request.capabilities
  project_disposition(proj, cap) == "requires_escalation"
  count(matching_active_grants) == 0

  requires_escalation_decision := {
    "outcome": "requires_escalation",
    "escalationKind": "cto_approval",
    "requestedScope": requested_scope_object,
    "reason": "project_policy_requires_escalation",
    "decisionId": new_decision_id,
    "policyVersion": data.hoplon.policy.policyVersion,
  }
}

# ─── 6. Default deny ──────────────────────────────────────────────────────────
default decision := {
  "outcome": "deny",
  "reason": "default_deny_no_rule_matched",
  "decisionId": "opa_decision_default_deny",
  "policyVersion": "hoplon_policy_bundle_unversioned",
}

# ─── helpers (sketched; concrete implementations live in the in-process evaluator) ───

new_decision_id := sprintf("opa_decision_%v", [input.context.sessionId])

# Branch disposition lookup with glob support: literal branches first, then
# globs (single-segment `*`). `release/*` matches `release/v1.2` but NOT
# `release/v1.2/hotfix`.
branch_disposition(projectId, branch, cap) := disp if {
  rules := data.hoplon.policy.branches[projectId]
  some pattern, ruleset in rules
  matches_branch_glob(branch, pattern)
  disp := ruleset[cap]
}
branch_disposition(_, _, _) := "allow"  # default fallthrough when no branch rule

# True if `value` matches the glob pattern.
matches_glob(value, pattern) = true {
  glob.match(pattern, ["/"], value)
}
matches_branch_glob(branch, pattern) = true {
  glob.match(pattern, ["/"], branch)
}
