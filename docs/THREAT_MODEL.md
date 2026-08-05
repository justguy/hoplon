# Hoplon Threat Model

## Purpose

Hoplon makes an agent's repository operation explicit, auditable, and
reversible. It reduces the authority gap between a natural-language request
and a filesystem diff.

It does not attempt to contain an arbitrary hostile process. Deploy Hoplon
inside normal operating-system, container, credential, and network controls.

## Protected assets

- source and configuration files inside an onboarded repository;
- the declared writable boundary;
- snapshot and audit integrity;
- source-bearing review and repair evidence;
- project, run, branch, folder, and principal isolation;
- secrets and sensitive identifiers that must not leak into operational logs.

## Trust assumptions

Hoplon assumes:

- the host process and injected adapters are trusted for the authority they
  receive;
- the configured project root is correct;
- parser runtimes, grammar artifacts, package-lock integrity, and snapshot
  storage have not been replaced by an attacker;
- the host assigns correct project, run, correlation, principal, and branch
  facts;
- operating-system permissions prevent unrelated users from modifying Hoplon's
  process or storage.

An adapter can only be as trustworthy as its implementation. A malicious
filesystem, versioning, policy, or evidence adapter can lie to the engine.

## Security guarantees in scope

For supported non-binary source and configured parsers, Hoplon is designed to:

- reject malformed or path-escaping manifests;
- snapshot the declared baseline before supervised mutation;
- compare proposed or live edits against file and AST scope;
- identify uncontracted files and out-of-scope structural changes;
- restore contracted files and delete uncontracted post-snapshot creations
  outside the revert allowlist;
- keep deterministic verdicts independent from model or semantic-provider
  output;
- return typed unavailable/degraded states when optional providers are absent;
- keep content-bearing evidence out of ordinary operational events and audit
  rows.

These are implementation properties, not a claim that the project has
received an independent security audit.

## Out of scope

Hoplon does not:

- sandbox shell commands, compilers, package scripts, or arbitrary processes;
- prevent a separately authorized tool from writing around Hoplon;
- validate the semantic correctness or safety of code;
- replace tests, code review, malware scanning, DLP, or deployment policy;
- guarantee that every language or generated/binary format has an AST-aware
  boundary;
- make an untrusted host or adapter trustworthy;
- choose retry, approval, escalation, or model-budget policy.

## Main failure modes

### Incorrect manifest

A too-broad manifest can authorize an unsafe change while Hoplon correctly
reports `PASS`. Humans and hosts must construct least-authority manifests and
review whole-file scopes carefully.

### Compatibility writes

`markEdited` declares bytes written by a host-owned editor. It is provided for
compatibility, but the host can write before Hoplon sees the change. Prefer
`applyEdits` for strict agent paths.

### Parser or grammar gaps

AST enforcement depends on supported, pinned parsers and grammars. Unsupported
files must use an explicitly understood fallback or remain outside the
structural claim.

### Optional-provider confusion

Semantic retrieval, references, behavior tests, DLP, anomaly scoring, and risk
prediction are advisory unless the host establishes a separate policy. Their
sidecars never prove a deterministic boundary verdict.

### Authorization configuration

Capability-token, OPA, and RBAA enforcement are opt-in. Default availability of
an adapter seam does not mean dynamic authorization is active.

### Evidence disclosure

Review and repair payloads can contain source. Treat them as repository data,
scope their recipients, and apply retention policy outside Hoplon.

## Deployment guidance

- Run agents with least operating-system and network privilege.
- Give the agent Hoplon's supervised surfaces instead of an unrestricted
  editor whenever practical.
- Pin and verify dependencies and grammar artifacts.
- Protect the snapshot database and internal git object store.
- Keep HTTP listeners on loopback unless an authenticated embedding host
  explicitly supplies network policy.
- Use strict-agent profile only after project registration and folder policy
  are correctly configured.
- Preserve human review for broad manifests, security-sensitive paths, and
  deployment changes.
- Monitor `UNAVAILABLE` and `DEGRADED` states as real operational signals.
