package hoplon.rbaa.v1
import future.keywords.if
import future.keywords.in
default decision := {
  "schemaVersion": 1,
  "outcome": "deny",
  "decisionId": "rbaa_decision_default",
  "policyVersion": "rbaa_policy_bundle_2026_05_06",
  "risk": {
    "evaluationId": "risk_eval_default",
    "band": "R4_QUARANTINE_OR_DENY",
    "scoreBucket": "80-100",
    "autonomyTier": "A0_OBSERVER",
    "controls": ["quarantine_required", "enhanced_audit"],
    "topFactors": [
      {
        "id": "default-deny",
        "source": "policy_engine",
        "label": "default deny",
        "severity": "critical"
      }
    ]
  },
  "reason": "default_deny_no_policy_rule_matched",
}
policy := data.rbaa.policy
capability_keys := {"read", "search", "write", "lock", "snapshot"}
decision := deny_decision if {
  deny_reason != ""
}
decision := quarantine_decision if {
  deny_reason == ""
  quarantine_reason != ""
}
decision := approval_decision if {
  deny_reason == ""
  quarantine_reason == ""
  approval.reason != ""
}
decision := grant_allow_decision if {
  deny_reason == ""
  quarantine_reason == ""
  approval.reason == ""
  count(matching_grants) > 0
}
decision := escalation_decision if {
  deny_reason == ""
  quarantine_reason == ""
  approval.reason == ""
  count(matching_grants) == 0
  requires_escalation
}
decision := standing_allow_decision if {
  deny_reason == ""
  quarantine_reason == ""
  approval.reason == ""
  count(matching_grants) == 0
  not requires_escalation
  all_requested_capabilities_allowed
}
deny_decision := {
  "schemaVersion": 1,
  "outcome": "deny",
  "decisionId": decision_id,
  "policyVersion": policy.policyVersion,
  "risk": risk_posture,
  "reason": deny_reason,
}
quarantine_decision := {
  "schemaVersion": 1,
  "outcome": "quarantine",
  "decisionId": decision_id,
  "policyVersion": policy.policyVersion,
  "risk": risk_posture,
  "reason": quarantine_reason,
}
approval_decision := {
  "schemaVersion": 1,
  "outcome": "requires_approval",
  "decisionId": decision_id,
  "policyVersion": policy.policyVersion,
  "risk": risk_posture,
  "escalationKind": approval.kind,
  "requestedScope": requested_scope,
  "requiredControls": approval.controls,
  "reason": approval.reason,
}
escalation_decision := {
  "schemaVersion": 1,
  "outcome": "requires_escalation",
  "decisionId": decision_id,
  "policyVersion": policy.policyVersion,
  "risk": risk_posture,
  "escalationKind": "self_service",
  "requestedScope": requested_scope,
  "requiredControls": ["enhanced_audit", "short_ttl"],
  "reason": "project_or_risk_requires_escalation",
}
standing_allow_decision := {
  "schemaVersion": 1,
  "outcome": "allow",
  "decisionId": decision_id,
  "policyVersion": policy.policyVersion,
  "risk": risk_posture,
  "source": "standing_policy",
  "capabilities": requested_scope,
  "limits": policy.defaultLimits,
}
grant_allow_decision := {
  "schemaVersion": 1,
  "outcome": "allow",
  "decisionId": decision_id,
  "policyVersion": policy.policyVersion,
  "risk": risk_posture,
  "source": "escalation_grant",
  "capabilities": grant_capabilities,
  "limits": policy.grantLimits,
  "grantIds": [grant.grantId | grant := matching_grants[_]],
}
decision_id := sprintf("rbaa_decision_%s_%s", [input.context.sessionId, risk_posture.evaluationId])
deny_reason := reason if {
  unsupported_capability
  reason := "unsupported_capability"
} else := reason if {
  not known_project
  reason := sprintf("unknown_project:%s", [input.request.projectId])
} else := reason if {
  hard_denied_path
  reason := "hard_deny_path"
} else := ""
quarantine_reason := reason if {
  request_matches_any(policy.quarantinePaths)
  reason := "quarantine_path"
} else := reason if {
  risk_band == "R4_QUARANTINE_OR_DENY"
  reason := "risk_band_quarantine"
} else := ""
approval := {"kind": kind, "controls": controls, "reason": reason} if {
  request_matches_any(policy.sensitivePaths)
  kind := "security_approval"
  controls := ["security_review_required", "enhanced_audit"]
  reason := "sensitive_path"
} else := {"kind": kind, "controls": controls, "reason": reason} if {
  not request_matches_any(policy.sensitivePaths)
  protected_branch
  kind := "human_approval"
  controls := ["human_review_required", "enhanced_audit"]
  reason := "protected_branch"
} else := {"kind": kind, "controls": controls, "reason": reason} if {
  not request_matches_any(policy.sensitivePaths)
  not protected_branch
  risk_band == "R3_APPROVAL"
  kind := "human_approval"
  controls := ["human_review_required", "test_gate_required", "enhanced_audit"]
  reason := "risk_band_requires_approval"
} else := {"kind": "", "controls": [], "reason": ""}
requires_escalation if {
  risk_band == "R2_ESCALATE"
}
requires_escalation if {
  some cap in input.request.capabilities
  project_disposition(cap) == "requires_escalation"
}
all_requested_capabilities_allowed if {
  every cap in input.request.capabilities {
    project_disposition(cap) == "allow"
  }
}
known_project if {
  policy.projects[input.request.projectId]
}
unsupported_capability if {
  some cap in input.request.capabilities
  not capability_keys[cap]
}
hard_denied_path if {
  request_matches_any(policy.hardDenyPaths)
}
protected_branch if {
  some pattern in policy.protectedBranches
  glob.match(pattern, ["/"], input.request.branch)
}
project_disposition(cap) := disposition if {
  disposition := policy.projects[input.request.projectId].default[cap]
}
project_disposition(_) := "deny" if {
  not known_project
}
matching_grants := [grant |
  grant := input.activeGrants[_]
  grant.principalId == input.principal.id
  grant.projectId == input.request.projectId
  grant.taskId == input.task.id
  not grant.revokedAt
  not revoked_grant(grant.grantId)
  time.parse_rfc3339_ns(grant.expiresAt) > time.parse_rfc3339_ns(input.context.now)
  grant_covers_request(grant)
]
revoked_grant(grant_id) if {
  some revoked in policy.revokedGrantIds
  revoked == grant_id
}
grant_covers_request(grant) if {
  every cap in input.request.capabilities {
    grant_capability_covers(grant.capabilities[cap])
  }
}
grant_capability_covers(claim) if {
  claim.paths
  claim.branches
  every path in request_paths {
    glob_match_any(claim.paths, path)
  }
  glob_match_any(claim.branches, input.request.branch)
}
grant_capabilities := {cap: matching_grants[0].capabilities[cap] |
  cap := input.request.capabilities[_]
  matching_grants[0].capabilities[cap]
}
requested_scope := {cap: {"paths": request_paths, "branches": [input.request.branch]} |
  cap := input.request.capabilities[_]
  capability_keys[cap]
}
request_paths := paths if {
  paths := input.request.paths
  count(paths) > 0
} else := ["**"]
request_matches_any(patterns) if {
  some path in request_paths
  glob_match_any(patterns, path)
}
glob_match_any(patterns, value) if {
  some pattern in patterns
  glob.match(pattern, ["/"], value)
}
risk_posture := {
  "evaluationId": sprintf("risk_eval_%s", [input.context.sessionId]),
  "band": risk_band,
  "scoreBucket": risk_score_bucket,
  "autonomyTier": risk_autonomy_tier,
  "controls": risk_controls,
  "topFactors": input.riskFacts.facts,
}
risk_band := "R4_QUARANTINE_OR_DENY" if {
  some factor in input.riskFacts.facts
  factor.severity == "critical"
} else := "R3_APPROVAL" if {
  some factor in input.riskFacts.facts
  factor.severity == "high"
} else := "R2_ESCALATE" if {
  some factor in input.riskFacts.facts
  factor.severity == "medium"
} else := "R1_GUARDED" if {
  some factor in input.riskFacts.facts
  factor.severity == "low"
} else := "R0_LOW"
risk_score_bucket := "80-100" if {
  risk_band == "R4_QUARANTINE_OR_DENY"
} else := "60-79" if {
  risk_band == "R3_APPROVAL"
} else := "40-59" if {
  risk_band == "R2_ESCALATE"
} else := "20-39" if {
  risk_band == "R1_GUARDED"
} else := "0-19"
risk_autonomy_tier := "A0_OBSERVER" if {
  risk_band == "R4_QUARANTINE_OR_DENY"
} else := "A1_PROPOSER" if {
  risk_band == "R3_APPROVAL"
} else := "A2_SCOPED_EDITOR" if {
  risk_band == "R2_ESCALATE"
} else := "A3_MULTI_FILE_EDITOR"
risk_controls := ["quarantine_required", "enhanced_audit"] if {
  risk_band == "R4_QUARANTINE_OR_DENY"
} else := ["human_review_required", "test_gate_required", "enhanced_audit"] if {
  risk_band == "R3_APPROVAL"
} else := ["short_ttl", "narrow_path_scope", "enhanced_audit"] if {
  risk_band == "R2_ESCALATE"
} else := ["short_ttl", "enhanced_audit"] if {
  risk_band == "R1_GUARDED"
} else := ["enhanced_audit"]
