# Contributing to Hoplon

Hoplon welcomes bug reports, host integrations, language support, adapter
implementations, documentation improvements, and focused design proposals.

## Before opening a change

- Use a GitHub issue or discussion for a substantial public-contract or
  architecture change.
- Use private vulnerability reporting for security findings; do not post
  exploit details in a public issue.
- Keep a pull request bounded to one coherent behavior or contract slice.

## Development setup

Requirements: Node.js 22 or newer and Git.

```bash
git clone https://github.com/justguy/hoplon.git
cd hoplon
npm ci
npm run build
```

Common proof commands:

```bash
npm run lint
npm run typecheck
npm run test:arch
npm run test:contracts
npm run test:proof
npm run test:standalone
```

Use a narrower `npx vitest run tests/path/to/file.test.ts` while developing.
CI runs the public release gates.

## Design expectations

Hoplon is a deterministic repository boundary, not an orchestrator.

- Keep I/O behind adapters.
- Preserve the separation between deterministic authority and advisory
  intelligence.
- Return explicit unavailable/degraded states rather than fabricated success.
- Give every durable field or contract object a writer, consumer, enforcement
  point, and live proof.
- Keep public DTO changes additive on the `0.4.x` preview line when possible.
- Do not bundle license-sensitive optional tools into MIT-licensed core.

Read `ARCHITECTURE.md` and `AGENTS.md` before changing the engine surface.

## Pull requests

A useful pull request includes:

- the problem and user-visible outcome;
- the exact contract or behavior change;
- targeted tests proving the claim;
- explicit behavior-change and compatibility notes;
- architecture/changelog updates when the public truth changes.

By submitting a contribution, you agree that it may be distributed under the
license applicable to the files you modify.
