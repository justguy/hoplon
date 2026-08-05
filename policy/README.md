# Hoplon OPA Policy Bundles

## Dynamic RBAA v1 bundle (opt-in, deployable)

`policy/rbaa/v1/` is the deployable Dynamic RBAA v1 OPA bundle. It consumes
the `RbaaAuthorizationRequestSchema` shape from
`src/hoplon/contracts/rbaaAuthorization.ts` and emits decisions compatible
with `RbaaAuthorizationDecisionSchema`.

Bundle layout:

```text
policy/rbaa/v1/.manifest
policy/rbaa/v1/data.json
policy/rbaa/v1/rbaa_authz.rego
policy/rbaa/v1/corpus.json
```

The corpus is exercised by `tests/policy/rbaaOpaPolicyBundle.test.ts` with a
real `opa eval` call. It covers allow, escalation, approval, quarantine, deny,
matching grants, revoked grants, protected branches, sensitive paths, and hard
deny paths.

This bundle is still opt-in. It is not imported by production runtime code and
does not change the default `StaticAuthorizationAdapter` handshake path.

## Legacy OPA adapter fixture (advisory / fixture-only)

> **Status:** advisory-only. `OpaAuthorizationAdapter` is NOT wired as the
> default runtime adapter. The handshake continues to use
> `StaticAuthorizationAdapter`. This bundle exists so the T-149 corpus
> tests and the T-150 end-to-end proof can exercise the OPA adapter
> against documented policy semantics — entirely **in process** through
> `BundledOpaClient` — without spawning a real OPA sidecar.

## Reference Rego file is NOT a deployable bundle

`policy/hoplon_authz.rego` is a **reference skeleton** that documents
the intended policy contract. It is **illustrative, not executable**:

- The decision logic Hoplon's tests actually exercise lives in
  `src/hoplon/authorization/policyBundle/evaluator.ts`.
- Tests reach the evaluator via `BundledOpaClient`, not via `opa run`.
- Running `opa run --bundle` against the current Rego file will NOT
  produce correct decisions — the Rego skeleton omits real bundle
  metadata, decision id sourcing, grant filtering, and several
  edge-case branches that the TypeScript evaluator implements.
- Production deployment of an executable OPA bundle is **out of scope
  for the Phase 4 advisory-only build.** It is a separate follow-up
  owned by the Agentic OS / GitOps publisher.

The T-149 lockstep contract still applies in spirit: any change to the
TypeScript evaluator semantics MUST be mirrored in the Rego skeleton
(and vice versa) so the contract document does not drift from the
implementation. The reference file is a contract document, not a
runtime artifact.

## Source-of-truth contract

Per the T-142 hard-gate review and T-149 brief, **policy authoring source of
truth lives in Agentic OS / GitOps publisher**, not in this repository.

Hoplon ships:

- `policy/hoplon_authz.rego` — reference Rego policy (skeleton; not
  deployable as-is — see above).
- `policy/data/hoplon_policy_data.json` — policy data fixture (projects,
  branches, sensitive paths, revoked grants).
- `src/hoplon/authorization/policyBundle/evaluator.ts` — TypeScript
  evaluator that mirrors the documented Rego semantics for hermetic
  in-process tests.

The Rego file and the in-process evaluator MUST stay in lockstep. Any
change to one must be mirrored in the other. The corpus tests
(`tests/policy/opaPolicyBundle.test.ts`) exercise the in-process
evaluator and assert the documented semantics so divergence surfaces
immediately.

## Sidecar deployment (forward-looking guidance — NOT a current step)

The block below is **forward-looking guidance**, not a current
deployment instruction. Hoplon does not yet ship a deployable OPA
bundle, and the reference Rego file above is not executable. When the
production OPA bundle is built (out of scope for the Phase 4 advisory-
only lane), the sidecar layout below is the recommended target.

In production the bundle is delivered to an OPA sidecar by the GitOps
publisher; Hoplon does not load Rego or JSON data at runtime.

Recommended sidecar layout:

```text
opa run \
  --server \
  --addr 0.0.0.0:8181 \
  --bundle /etc/opa/bundles/hoplon \
  --log-format json \
  --diagnostic-addr 0.0.0.0:8282
```

### Decision endpoint

`OpaAuthorizationAdapter` calls:

```http
POST http://localhost:8181/v1/data/hoplon/authz/decision
Content-Type: application/json
```

Body shape: see `src/hoplon/contracts/opaAuthorization.ts` and
`src/hoplon/authorization/opaAuthorizationAdapter.ts` (principal, task,
request, current context, and active grants).

The default decision path is exposed via
`DEFAULT_OPA_DECISION_PATH` from `opaAuthorizationAdapter.ts` and can be
overridden via the `decisionPath` constructor option.

### Health check

OPA exposes `GET /health?bundle=true` on the configured port.

```http
GET http://localhost:8181/health?bundle=true
```

A `200 OK` indicates the OPA process is up and the active bundle has been
activated. Operations should fail closed if the health check fails OR if
`POST /v1/data/hoplon/authz/decision` returns non-2xx for ≥3 consecutive
attempts within the configured window.

### Bundle activation

Bundles are signed and pulled from the Control Plane. Configure via OPA
`config.yaml` per the OPA bundle plugin docs; configuration is delivered
by the same GitOps publisher that owns the Rego source.

### Fail-closed behavior (adapter side)

`OpaAuthorizationAdapter` already enforces fail-closed semantics when:

1. The injected `OpaClient.evaluate(...)` returns
   `{ kind: 'error', reason }` — adapter returns `deny` with reason
   prefixed `opa_unavailable:`.
2. The decision payload fails normalization
   (`normalizeOpaDecision` returns `malformed`) — adapter returns `deny`
   with reason prefixed `opa_malformed_decision:`.
3. Active grant lookup fails AND the request requested any capability in
   `requireGrantsForCapabilities` (default: `write`, `lock`) — adapter
   returns `deny`.

Tests under `tests/policy/opaPolicyBundle.test.ts` cover (1) and (2) end
to end; the existing `tests/authorization/opaAuthorizationAdapter.test.ts`
covers (3).

## Layer order

```text
1. Global hard deny.            → deny       (explicit; wins everything)
2. Sensitive path restrictions. → requires_security_approval | deny
3. Project policy.              → allow | requires_escalation
4. Branch policy.               → requires_human_approval (overrides 3)
5. Active escalation grants.    → allow (escalation_grant) — only when 3 says requires_escalation
6. Default deny.                → deny
```

Explicit deny wins. Sensitive paths are evaluated *before* project allow
so a project-A blanket allow does not let a write touch `secrets/**`.

## Capabilities

The bundle understands these capability keys (single source of truth:
`BUNDLE_CAPABILITY_KEYS` in
`src/hoplon/authorization/policyBundle/evaluator.ts`):

```text
read | search | write | lock | snapshot
```

`snapshot` is a first-class capability and runs through every layer in
the same order as `write`/`lock`. Protected branches (`main`,
`release/*`) raise `requires_human_approval` for snapshot, sensitive
paths (`secrets/**`, `.env*`) raise `requires_security_approval`, and
Project B's standing default for snapshot is `requires_escalation` —
matching its write/lock pattern. A request that asks for `snapshot` and
cannot be granted at the resolved layer escalates the WHOLE request (or
denies it); the bundle never silently drops a requested capability.

## Token capabilities (concrete, not vague)

Every `allow` decision returns concrete `TokenCapabilities` per the
`ScopeClaim` contract in `src/hoplon/authorization/authorizationAdapter.ts`:

```ts
{
  read?: { paths: string[]; branches: string[]; ... };
  search?: { ... };
  write?: { ... };
  lock?: { ... };
  snapshot?: { ... };
}
```

The bundle never returns role names or empty objects.
`normalizeOpaDecision` rejects vague-role allows.

## Bundle version pin

The current bundle version is exported as
`HOPLON_POLICY_BUNDLE_VERSION` from
`src/hoplon/authorization/policyBundle/index.ts` and matches the
`policyVersion` field in `policy/data/hoplon_policy_data.json`. Tests
assert the round trip.
