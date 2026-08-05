## Outcome

<!-- What problem does this solve, and what becomes materially true? -->

## Scope

<!-- Name the bounded implementation and any public contracts it changes. -->

## Behavior changes

<!-- List intentional runtime/default/policy changes. Write "None" if none. -->

## Proof

<!-- Include exact targeted commands and the real path they exercise. -->

- [ ] Targeted regression/flow test passes
- [ ] `npm run typecheck` passes
- [ ] `npm run test:arch` passes when architecture is touched
- [ ] `npm run test:proof` passes when deterministic operations are touched
- [ ] Producer and consumer coverage exists for contract changes

## Boundary review

- [ ] Environment access remains behind adapters
- [ ] Advisory intelligence cannot silently change deterministic verdicts
- [ ] No unrequested blocking rule, threshold, retry policy, or evidence cap
- [ ] No credentials, local absolute paths, or private repository data
- [ ] Public architecture/changelog truth is updated when required
