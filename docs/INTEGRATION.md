# Integration

## Install

For the developer preview, build from the public repository:

```bash
git clone https://github.com/justguy/hoplon.git
cd hoplon
npm ci
npm run build
```

A Git dependency can also be used before the registry release:

```bash
npm install github:justguy/hoplon
```

Hoplon is ESM-only and requires Node.js 22 or newer.

## Local TypeScript API

```ts
import {
  createDefaultHoplonEngine,
  createHoplonEditSession,
  createNodeFsAdapter,
} from '@phalanx/hoplon';

const root = '/absolute/path/to/project';
const engine = await createDefaultHoplonEngine({
  root,
  dbPath: \`\${root}/.hoplon/hoplon.db\`,
  gitRepoDir: \`\${root}/.hoplon/repo\`,
  grammarsDir: '/absolute/path/to/hoplon/vendor/grammars',
  engineId: 'local-example',
});

const manifest = {
  manifestSchemaVersion: 2,
  projectId: 'example',
  runId: 'run-1',
  correlationId: 'edit-format-price',
  entries: [
    {
      path: 'src/format.ts',
      intent: 'modify',
      scope: { kind: 'symbols', symbols: ['formatPrice'] },
    },
  ],
};

const session = createHoplonEditSession({
  engine,
  manifest,
  fs: createNodeFsAdapter({ root }),
});

const preflight = await session.preflight();
if (preflight.status !== 'PASS') throw new Error('manifest rejected');

await session.createSnapshot();
await session.applyEdits([
  {
    file: 'src/format.ts',
    content: 'export function formatPrice(value) { return String(value); }\\n',
  },
]);

const audit = await session.audit();
if (audit.status === 'BLOCK') {
  await session.revert();
  const rollback = await session.extractRollbackTemplate();
  // Feed typed correction/repair evidence into host-owned review or retry.
  console.error(audit.violations, rollback);
}

session.close();
```

## CLI

```bash
hoplon status --root /path/to/project --format human
hoplon query see --root /path/to/project --help
hoplon mcp serve --root /path/to/project
hoplon http serve --root /path/to/project
```

Run `hoplon --help` and `hoplon query --help` for the current surface.

## MCP

The MCP server exposes the same engine and session contracts. A source checkout
can be launched with:

```bash
node /path/to/hoplon/dist/bin/hoplon.js mcp serve \
  --root /path/to/project \
  --grammars-dir /path/to/hoplon/vendor/grammars
```

Use one launcher root consistently for MCP discovery and project registration.
MCP-only agents cannot mutate project registration or folder policy; those are
host/operator actions.

## HTTP and gRPC

Hoplon also ships HTTP and gRPC dispatch/client surfaces over the typed engine
contracts. The launcher HTTP server binds loopback by default and refuses a
non-loopback host unless the operator explicitly overrides the safeguard.
Production exposure should be embedded behind host authentication and network
policy.

## Provider behavior

Reference local adapters cover filesystem, versioning, snapshot storage, locks,
tree-sitter intelligence, and basic secret warnings. Optional providers report
`UNAVAILABLE` or `DEGRADED` when not configured. They do not fabricate empty
success and do not silently change deterministic audit authority.

See `ARCHITECTURE.md` and `docs/HOPLON_PROVIDER_MAPPING.md` for the complete
adapter map.
