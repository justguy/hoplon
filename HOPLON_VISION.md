# Hoplon Vision

Hoplon is a deterministic repository-boundary engine for AI coding agents.

The premise is simple: probabilistic code generation needs deterministic
repository physics. An agent can propose a change, but the repository boundary
should be explicit, auditable, reversible, and mechanically enforced.

## The Problem

AI coding agents can generate useful code, but raw repository access makes basic
engineering questions hard to answer:

- What did the agent inspect?
- What was it allowed to modify?
- Did the final diff stay inside the requested boundary?
- Which evidence is deterministic, and which evidence is advisory?
- Can a failed attempt be reverted without contaminating the next attempt?
- Can a host prove what happened without trusting an agent summary?

Hoplon exists to make those questions answerable by contract rather than by
conversation.

## Product Position

Hoplon packages five repository-boundary capabilities:

1. Structured code reads with provenance.
2. Supervised non-binary edits.
3. Content-addressed snapshots.
4. Deterministic manifest and AST audits.
5. Recovery and evidence artifacts for host-controlled retry.

It is intentionally not an orchestrator. It does not decide whether to retry,
approve, escalate, run tests, or spend more model budget. It returns precise
facts and typed evidence so the host can make those decisions.

## Principles

**Deterministic authority is narrow.** `PASS` and `BLOCK` come from manifest,
snapshot, path, and AST checks. Semantic retrieval, ML scoring, behavior tests,
and provider-backed references are advisory unless a host builds a separate
policy around them.

**Unavailable is better than fabricated.** If semantic search, reference lookup,
RBAA, DLP, or behavior verification lacks a real provider, Hoplon reports that
state explicitly.

**Evidence is bounded.** Operational logs and audit rows carry identifiers,
counts, status, and reason codes. Content-bearing evidence stays in explicit
payloads or pointer-based proof surfaces.

**Adapters are the environment boundary.** Filesystems, git storage, locks,
code intelligence, policy engines, scanners, vector stores, and test runners
are injected. The engine core does not shell out or rely on ambient state.

**Hosts own workflow policy.** Hoplon provides `preflight`, `createSnapshot`,
`dryRun`, `auditDiff`, `revertUncontracted`, sessions, and evidence. The host
decides what those facts mean operationally.

## Capability Posture

| Capability | Posture |
|---|---|
| `seeCodebase` read/search macro | Shipped. Routes structural, skeleton, raw, and search primitives with provenance and fallback metadata. |
| Symbol search | Shipped. JS/TS declaration search over tree-sitter query bundles. |
| Structural query and templates | Shipped. `queryStructure`, `packContext`, and `extractStructuralTemplate` provide deterministic code context. |
| Semantic search | Shipped as local advisory engine methods. Requires host-bound embedding and vector-store adapters; default is `UNAVAILABLE`; MCP/HTTP/gRPC transport exposure is not shipped. |
| Cross-file references | Advisory and provider-dependent. Default tree-sitter path does not invent references. |
| Branch scope | Shipped as authorization and evidence scope, not generic cross-branch search. Capability claims can include branches; snapshot evidence is ref-scoped. |
| Supervised edit sessions | Shipped. Sessions drive preflight, snapshot, dry run, staged/apply edits, audit, review, verify, repair, revert, evidence, and close. |
| Snapshot evidence | Shipped. Diff, provenance, and line-provenance evidence are scoped to committed snapshots and manifest-owned files. |
| Dynamic authorization | Opt-in. Static authorization and folder policy are defaults; OPA/RBAA capability enforcement requires host injection. |
| DLP | Warn-by-default seam. Block mode is explicit; DLP does not feed structural audit verdicts. |
| Advisory ML | Provider-bound. Violation risk and anomaly scoring are schema-pinned advisory sidecars. |
| Trace and proof retrieval | Shipped when trace dependencies are supplied. Evidence remains bounded and pointer-oriented. |

## Why This Matters

Autonomous code work fails expensively when the first reliable check happens at
compile, test, or human review time. Hoplon shifts a large class of failures to
the repository boundary:

- invalid target
- uncontracted file creation
- out-of-scope symbol edit
- parse failure
- signature or import contract mismatch
- path or branch-policy mismatch
- stale snapshot or wrong project/run scope

Those are not model-quality judgments. They are mechanical facts that can be
checked before a host burns more model time or asks a reviewer to inspect a
polluted diff.

## The Category

Most code intelligence tools answer questions about a codebase:

- Where is this symbol?
- What imports this file?
- What does this type look like?
- What tests are likely relevant?

Hoplon uses those answers, but its core question is different:

> Did this agent attempt exactly the repository operation it was contracted to
> attempt, and can the host recover safely if it did not?

That is the contract boundary for AI-generated code. Hoplon is designed around
that boundary instead of treating it as an after-the-fact review problem.

## Determinism Claim

Hoplon's deterministic verdicts are reproducible for the same inputs, adapter
bindings, parser versions, grammars, snapshot records, and contract schema. The
claim is not that every provider in every deployment is identical. The claim is
that deterministic authority is isolated to the parts of the system that are
designed and tested to be reproducible.

Advisory providers can improve context and review, but they do not rewrite the
structural truth.

## Strategic Direction

The direction is to make agentic code work safer and cheaper by moving more
repository-boundary questions into typed, deterministic, host-composable
contracts:

- richer AST and symbol context without prompt bloat
- stronger session recovery and retry packages
- better snapshot-scoped evidence
- provider-bound semantic and reference intelligence
- explicit branch, path, and project authorization
- bounded audit evidence suitable for regulated environments
- strict separation between deterministic gates and advisory sidecars

Hoplon wins when a host can let an agent work quickly while still proving, in a
machine-readable way, what the agent touched and why the result is safe to keep.
