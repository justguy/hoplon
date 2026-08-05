# @phalanx/hoplon-vector-store-sqlite-vec

Optional native performance-tier semantic index package for Hoplon.

This package owns the `node:sqlite` runtime and `sqlite-vec` extension loading.
It is not a core dependency and is not the portable default. If `node:sqlite`
or the native extension cannot load, the package reports explicit degradation
and keeps lexical FTS5 available when possible.
