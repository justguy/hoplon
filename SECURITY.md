# Security Policy

Hoplon is a developer-preview repository-boundary engine. It is designed to
make agent reads and edits explicit, auditable, and reversible; it is not a
process sandbox, malware detector, or substitute for operating-system access
controls.

## Supported versions

Security fixes are currently made on the latest `0.4.x` release line and on
the default branch. Earlier development snapshots are not supported.

## Reporting a vulnerability

Please do not open a public issue for a suspected vulnerability. Use
[GitHub private vulnerability reporting](https://github.com/justguy/hoplon/security/advisories/new)
and include:

- the affected version or commit;
- the deployment surface involved (local API, CLI, MCP, HTTP, or gRPC);
- a minimal reproduction;
- the expected and observed boundary behavior;
- whether source code, secrets, filesystem paths, or authorization data may
  have been exposed.

We will acknowledge the report, validate its scope, and coordinate disclosure
before publishing a fix. Please avoid accessing data or repositories you do
not own or have permission to test.

## Security boundary

Hoplon's deterministic authority is intentionally narrow: manifest, path,
snapshot, and AST checks. Optional semantic, ML, reference, DLP, and behavior
providers are advisory unless a host explicitly applies separate policy.

The host remains responsible for:

- filesystem and process isolation;
- credentials and network policy;
- choosing trusted adapter implementations;
- test execution and human approval;
- retry, escalation, and deployment decisions.

See [the threat model](docs/THREAT_MODEL.md) for the full trust and non-goal
boundary.
