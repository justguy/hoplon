# Changelog

All notable public changes to Hoplon are recorded here.

Hoplon follows semantic versioning after `1.0`. During the `0.x` developer
preview, breaking changes remain possible and will be called out explicitly.

## 0.4.0 — 2026-08-05

Initial standalone open-source developer preview.

### Included

- deterministic manifest, snapshot, path, and AST boundary enforcement;
- structured reads, symbol search, syntax lookup, and context packing;
- supervised edit sessions with dry-run, audit, review, revert, and repair
  evidence;
- local TypeScript, CLI, MCP, HTTP, and gRPC surfaces;
- reference filesystem, isomorphic-git, sql.js, lock, tree-sitter, and scanner
  adapters;
- optional adapter packages kept outside the core dependency boundary;
- contract, architecture, self-hosting, transport, and flow proof suites.

### Distribution note

Hoplon originated as a Project Phalanx subsystem. This release establishes
`github.com/justguy/hoplon` as the standalone public distribution without
publishing the private development history or operational artifacts.
