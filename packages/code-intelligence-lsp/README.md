# @phalanx/hoplon-code-intelligence-lsp

LSP server plugin for [@phalanx/hoplon](../../README.md).

Binds the `LspProvider` seam (from LSP1 — `createLspCodeIntelligence`) to a real LSP server process via JSON-RPC over stdio using `vscode-jsonrpc`.

---

## Installation

```sh
npm install @phalanx/hoplon-code-intelligence-lsp
# vscode-jsonrpc is a direct dependency of this package (not core)
```

Core `@phalanx/hoplon` is declared as a peer dependency. Install it separately.

---

## Usage

```ts
import { createHoplonEngine } from '@phalanx/hoplon';
import { createLspCodeIntelligence } from '@phalanx/hoplon';
import { createTreeSitterIntelligence } from '@phalanx/hoplon';
import { createLspProvider } from '@phalanx/hoplon-code-intelligence-lsp';

// 1. Create the LSP provider (spawns the server lazily on first call)
const lspProvider = createLspProvider({
  serverCommand: 'typescript-language-server',
  serverArgs: ['--stdio'],          // default; most LSP servers accept --stdio
  // rootUri: 'file:///my/project', // defaults to file://<cwd>
});

// 2. Create the fallback tree-sitter adapter
const treeSitterAdapter = createTreeSitterIntelligence({
  grammarsDir: './node_modules',
});

// 3. Compose: LSP1 adapter wraps lspProvider, falls back to tree-sitter
const codeIntelligenceAdapter = createLspCodeIntelligence({
  lspProvider,
  fallbackAdapter: treeSitterAdapter,
});

// 4. Wire into the engine
const engine = createHoplonEngine({
  adapters: {
    // ... other adapters ...
    codeIntelligence: codeIntelligenceAdapter,
  },
});

// 5. At shutdown — dispose the LSP server process
await lspProvider.dispose();
```

---

## API

### `createLspProvider(opts): JsonRpcLspClient`

Factory function. Returns a `JsonRpcLspClient` which structurally satisfies
the `LspProvider` seam interface from `@phalanx/hoplon`.

| Option | Type | Default | Description |
|---|---|---|---|
| `serverCommand` | `string` | — | LSP server binary (`'typescript-language-server'`, `'pyright-langserver'`, `'rust-analyzer'`, …) |
| `serverArgs` | `string[]` | `['--stdio']` | Args passed to the binary |
| `rootUri` | `string` | `file://<cwd>` | Workspace root for LSP `initialize` handshake |

### `JsonRpcLspClient`

The class returned by `createLspProvider`. Exposes:

- `resolveSignature(file, position)` → `Promise<LspSignatureResult | undefined>`
- `resolveImport(file, specifier)` → `Promise<LspImportResolutionResult | undefined>`
- `findReferences(file, symbol)` → `Promise<LspReferenceResult[]>`
- `dispose()` → `Promise<void>` — sends LSP `shutdown` + `exit`, then kills the process

The client is **lazy**: the LSP server is not spawned until the first method call.

---

## Integration tests

Integration tests are skipped by default. Run them against a real LSP server:

```sh
# Requires: npm install -g typescript-language-server typescript
RUN_INTEGRATION=1 npx vitest run tests/
```

---

## Architecture note

This package declares `@phalanx/hoplon` as a **peer dependency** (not a `dependency`).
Core Hoplon never imports this package. The plugin is entirely opt-in.

`vscode-jsonrpc` lives **only** in this package's `dependencies` — never in core `@phalanx/hoplon`.
