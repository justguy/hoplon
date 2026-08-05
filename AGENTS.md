# Agent Guide

These instructions apply to the entire repository.

## Start here

Read:

1. `README.md`
2. `HOPLON_VISION.md`
3. `ARCHITECTURE.md`
4. `CONTRIBUTING.md`

## Working method

Use `TRACE -> REPORT -> FIX -> PROVE`:

1. Trace the complete data path and identify the writer, consumer, enforcement
   point, and lifecycle of every changed contract.
2. Report the observed behavior and the weakest link before changing code.
3. Fix the smallest complete slice; do not add parallel mechanisms.
4. Prove the claimed behavior through a real operation, session, handler, or
   transport path.

## Architecture rules

- Environment access belongs behind injected adapters.
- Hoplon never owns model selection, retry, escalation, or approval policy.
- Deterministic `PASS`/`BLOCK` authority uses manifest, path, snapshot, and AST
  facts only.
- Advisory providers must report unavailable or degraded states honestly and
  cannot silently change deterministic verdicts.
- Imports flow from engine and operations toward adapters/contracts/pure
  utilities, never toward a host orchestrator.
- Use named ES-module exports, strict TypeScript, and `async`/`await`.
- Keep every TypeScript file under `src/hoplon` at or below 300 lines.
- Do not truncate agent-facing evidence with arbitrary character caps.
- Avoid new defaults, thresholds, or blocking behavior unless the change is
  explicit, justified, documented, and supported by an adversarial corpus.

## Tests

- Bug fixes require a regression test that reproduces the failure.
- Contract changes require producer and consumer coverage.
- Runtime claims require a real handler, dispatch, session, or flow test.
- Prefer the narrow Vitest file or directory that owns the changed surface.
- Run `npm run test:arch` for architecture changes and `npm run test:proof` for
  deterministic kernel changes.
- Tests must inject filesystem, versioning, snapshot, lock, provider, and
  behavior-runner dependencies rather than relying on ambient services.

## Public-repository hygiene

- Never commit credentials, local absolute paths, private tracker state, model
  transcripts, or proprietary repository content.
- Keep examples synthetic and reproducible.
- Security findings must follow `SECURITY.md`.
- Update `ARCHITECTURE.md` and `CHANGELOG.md` when public contracts, defaults,
  data flow, or subsystem boundaries change.
