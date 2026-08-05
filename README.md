# Hoplon

[![CI](https://github.com/justguy/hoplon/actions/workflows/ci.yml/badge.svg)](https://github.com/justguy/hoplon/actions/workflows/ci.yml)
[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js 22+](https://img.shields.io/badge/node-%3E%3D22-339933.svg)](package.json)

**Deterministic repository boundaries for AI coding agents and the humans who
direct them.**

Hoplon sits between an agent and a repository. A human or host declares what
the agent may inspect and modify; Hoplon supplies structured reads, supervised
edits, content-addressed snapshots, deterministic audits, recovery, and
machine-readable evidence.

Hoplon began as the repository boundary for Project Phalanx. It is intentionally
standalone: any agent, MCP client, CI worker, or custom host can use the same
contracts without adopting Phalanx.

> **Developer preview:** the deterministic core and shipped transports are
> usable today, but the public API is still on the `0.4.x` line. Expect additive
> growth and clearly documented compatibility changes before `1.0`.

## Why Hoplon

Agentic coding can waste context and reviewer time long before a test fails.
Hoplon moves mechanical questions to the repository boundary:

- What was the agent allowed to read or change?
- Did the resulting diff stay within that contract?
- Was a symbol, signature, import, path, or file boundary violated?
- Can a failed attempt be reverted without contaminating the next one?
- Which claims are deterministic, and which are only advisory?

The answer is a typed result backed by snapshots and AST checks, not an agent
summary that the host must trust.

## What ships

| Capability | Posture |
|---|---|
| Structured reads and search | Shipped through `seeCodebase`, symbol search, tree-sitter queries, templates, and AST-bounded context packing |
| Supervised non-binary edits | Shipped through ordered edit sessions and MCP/HTTP session tools |
| Snapshots and deterministic audit | Shipped through `preflight`, `createSnapshot`, `dryRun`, `auditDiff`, and `revertUncontracted` |
| Recovery and review evidence | Shipped through review payloads, rollback templates, repair context, and snapshot evidence |
| CLI, MCP, HTTP, and gRPC | Shipped over the same engine contracts |
| Semantic, ML, DLP, and provider-backed references | Advisory and host-bound; unavailable is reported honestly when no provider is configured |

Hoplon does **not** choose models, execute arbitrary shell commands, own retry
policy, or replace tests and human review.

## Quick start

Requirements: Git and Node.js 22 or newer.

```bash
git clone https://github.com/justguy/hoplon.git
cd hoplon
npm ci
npm run build
node dist/bin/hoplon.js status \
  --root . \
  --grammars-dir vendor/grammars \
  --format human
```

Run the executable boundary example:

```bash
npm run example:bounded-edit
```

It creates an isolated temporary repository, accepts an edit inside the
declared symbol boundary, blocks an out-of-scope symbol, reverts the workspace,
and prints the evidence returned by the real session path.

For development proof:

```bash
npm run typecheck
npm run test:arch
npm run test:contracts
npm run test:proof
```

## The contract

A writable manifest is the boundary a human or host gives the agent:

```ts
const manifest = {
  manifestSchemaVersion: 2,
  projectId: 'widget',
  runId: 'run-42',
  correlationId: 'change-price-format',
  entries: [
    {
      path: 'src/format.ts',
      intent: 'modify',
      scope: { kind: 'symbols', symbols: ['formatPrice'] },
    },
  ],
};
```

The normal supervised loop is:

```text
read with provenance
  -> declare manifest
  -> preflight
  -> snapshot
  -> dry-run (optional)
  -> apply or declare edits
  -> audit
       PASS  -> review/evidence -> close
       BLOCK -> revert -> repair context -> host decides what follows
```

Hoplon owns repository facts. The host owns workflow policy.

## Connect an agent over MCP

After building Hoplon, point an MCP client at the launcher. Replace the two
absolute paths with the Hoplon checkout and the repository the agent should
work in:

```json
{
  "mcpServers": {
    "hoplon": {
      "command": "node",
      "args": [
        "/absolute/path/to/hoplon/dist/bin/hoplon.js",
        "mcp",
        "serve",
        "--root",
        "/absolute/path/to/target-repository",
        "--grammars-dir",
        "/absolute/path/to/hoplon/vendor/grammars"
      ]
    }
  }
}
```

Use `--agent-profile strict-agent` when the host has completed project
registration and folder-policy onboarding. The default profile remains the
compatibility surface.

## Use as a library

The public package name is `@phalanx/hoplon`; the name records the project's
origin, not a runtime dependency on Phalanx.

```ts
import {
  createDefaultHoplonEngine,
  createHoplonEditSession,
} from '@phalanx/hoplon';
```

The engine is adapter-first. Filesystems, versioning, snapshot stores, locks,
code intelligence, scanners, policy providers, vector stores, and behavior
test runners are injected rather than read from ambient state.

See [Integration](docs/INTEGRATION.md) and
[Host workflow](docs/HOST_WORKFLOW.md) for the supported entry points.

## Security model

Hoplon's deterministic verdicts use manifest, path, snapshot, and AST facts.
Semantic retrieval, model output, behavior tests, risk scores, and optional
provider results cannot silently change structural `PASS`/`BLOCK` authority.

Hoplon is not a process sandbox. Read [SECURITY.md](SECURITY.md) and the
[threat model](docs/THREAT_MODEL.md) before granting an agent repository
access.

## Repository map

- `src/hoplon/contracts` — versioned DTOs and schemas
- `src/hoplon/operations` — deterministic and advisory operations
- `src/hoplon/session` — supervised edit state machine
- `src/hoplon/adapters` — environment seams and default implementations
- `src/hoplon/transport`, `src/hoplon/mcp` — remote and agent-facing surfaces
- `packages` — optional adapter packages
- `tests` — contract, flow, transport, self-hosting, and architecture proof

The current implementation truth is in [ARCHITECTURE.md](ARCHITECTURE.md).
The product intent is in [HOPLON_VISION.md](HOPLON_VISION.md).

## Contributing

Issues, design feedback, host integrations, language support, and adapter
contributions are welcome. Start with [CONTRIBUTING.md](CONTRIBUTING.md).
Security findings belong in private vulnerability reports, not public issues.

## License

Hoplon core is available under the [MIT License](LICENSE). Optional packages
declare their own licenses; in particular, the Semgrep adapter remains a
separate LGPL-licensed package and is never bundled into the MIT core.
