# @phalanx/hoplon-embedding-transformers-wasm

Optional local embedding adapter for Hoplon semantic search.

The package owns the `@huggingface/transformers@3.8.1` dependency and configures
Transformers.js for ONNX Runtime Web/WASM only. Remote model loading is disabled
before the model pipeline is constructed. Operators must provide local model and
WASM asset paths plus artifact hashes; missing assets degrade instead of causing
network fetches.

The adapter exposes a V2 batch embedding contract with `describe(req, signal?)`
and `embed(req, signal?)`. It reports artifact status, model/tokenizer/WASM
hashes, cold-start latency, per-input result statuses, and an
`embeddingProfileHash` suitable for downstream cache identity.
