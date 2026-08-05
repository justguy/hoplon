# @phalanx/hoplon-semantic-index-portable

Optional portable semantic index package for Hoplon deployments that cannot bind
native SQLite/vector runtimes or browser-local vector engines.

This package intentionally reports the `lexical_only_degraded` storage profile:
durable lexical search is available through host-provided snapshot storage, while
vector indexing is unavailable and reported in provenance.
