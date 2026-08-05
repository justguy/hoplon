# Host Workflow

Hoplon is designed for both direct human use and embedding inside an agent
host. The host owns intent and workflow policy; Hoplon owns repository facts.

## Roles

The human:

- states the goal;
- approves the repository, files, symbols, and risk boundary;
- reviews broad or security-sensitive changes.

The host:

- translates intent into a writable manifest;
- chooses what context to expose;
- drives the ordered session;
- runs tests and decides whether to retry, approve, escalate, or stop.

The agent:

- reads through bounded, provenance-bearing tools;
- proposes or applies changes within the declared scope;
- consumes precise correction and repair evidence after a block.

Hoplon:

- validates the contract;
- snapshots the baseline;
- supervises non-binary edits;
- audits the actual result;
- reverts and packages evidence when the result violates the contract.

## Recommended sequence

1. Onboard the repository root and any folder policy.
2. Read with `seeCodebase`, symbol search, or structural templates.
3. Declare a least-authority manifest.
4. Run `preflight`.
5. Run `createSnapshot`.
6. Optionally evaluate proposed changes with `dryRun`.
7. Prefer `applyEdits`; use `markEdited` only for a host-owned compatibility
   editor.
8. Run `audit` against the actual changed files.
9. On `PASS`, package review/snapshot evidence, run host-owned tests, and close.
10. On `BLOCK`, revert, extract a rollback template and repair context, then let
    the host choose the next action.

## Saving context and tokens

The default response to a large repository should not be “read every file.”
Use:

- project description for orientation;
- symbol search to locate declarations;
- structural templates for imports, exports, and types;
- AST-bounded context for the exact implementation body;
- raw reads only when exact text is required.

Hoplon reports routing, fallback, truncation, and provider provenance so the
host can distinguish a compact structural answer from a raw-file fallback.

## Boundary design

Prefer symbol scope when a stable declared symbol owns the requested change.
Use whole-file scope when structure genuinely spans the file and the reviewer
accepts the broader authority. Separate unrelated files into separate entries.

Do not infer that a valid manifest expresses the user's intent perfectly.
Hoplon enforces the supplied contract; humans and hosts remain responsible for
constructing the right contract.

## Agent profiles

The default MCP/HTTP profile preserves compatibility surfaces.

The `strict-agent` profile is intended for exclusive supervised access. It
requires correct project registration, folder-policy onboarding, and an
engagement handshake. Missing trusted facts fail closed instead of falling
back to ambient access.

## Tests and approval

Behavior verification is advisory and host-owned. A passing test cannot widen
the writable manifest or turn a structural `BLOCK` into `PASS`. Likewise, a
structural `PASS` does not imply that the code is correct.
