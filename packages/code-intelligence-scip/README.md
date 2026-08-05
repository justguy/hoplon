# @phalanx/hoplon-code-intelligence-scip

Offline SCIP-style Layer 2 provider for `@phalanx/hoplon`.

Current branch truth: this package consumes a deterministic JSON snapshot
projection of the SCIP-style data Hoplon needs for Layer 2 queries. It does not
yet parse raw `.scip` protobuf artifacts directly.

Scope on this branch:

- host-opt-in only
- tree-sitter remains the shipped default `codeIntelligence` binding
- answers `findReferences` and `findDependencies` from a deterministic offline
  snapshot
- surfaces missing-index and stale-revision state explicitly instead of treating
  the index as ambient truth
- returns an object that structurally satisfies Hoplon's
  `CodeIntelligenceAdapter` seam

This package does not change Hoplon `auditDiff` semantics and does not make
SCIP the default runtime path.
