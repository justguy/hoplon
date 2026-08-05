# @phalanx/hoplon-secret-scanner-gitleaks

Real `GitleaksProvider` implementation for `@phalanx/hoplon`'s `SecretScannerAdapter`.
Shells out to the `gitleaks` CLI binary via Node's `child_process`.

This package is intentionally separate from `@phalanx/hoplon` core —
only consumers that have `gitleaks` installed need to depend on it.

## Requirements

- Node 20+
- `gitleaks` binary on `PATH` (or configure `binaryPath`)
- `@phalanx/hoplon` as a peer dependency

## Usage

```typescript
import { createGitleaksSecretScanner } from '@phalanx/hoplon';
import { createGitleaksProvider } from '@phalanx/hoplon-secret-scanner-gitleaks';

// Create the provider (shells out to 'gitleaks' on PATH by default)
const provider = createGitleaksProvider({
  binaryPath: 'gitleaks',   // default; omit if gitleaks is on PATH
  configPath: './gitleaks.toml', // optional: path to gitleaks TOML config
});

// Pass it into the GL1 adapter from @phalanx/hoplon
const scanner = createGitleaksSecretScanner({ gitleaksProvider: provider });

// Use the scanner
const findings = await scanner.scan({
  path: 'src/config.ts',
  content: Buffer.from('const key = "AKIAIOSFODNN7EXAMPLE";'),
});

// findings[0] => { patternName: 'aws-access-token', lineNumber: 1, redactedSnippet: '...[REDACTED]...' }
// Note: raw secret values are redacted by the GL1 adapter before reaching callers.
```

## API

### `createGitleaksProvider(opts?)`

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `binaryPath` | `string` | `'gitleaks'` | Path to the gitleaks binary |
| `configPath` | `string` | — | Optional TOML config file path (instance-level default) |

Returns a `GitleaksProvider` (from `@phalanx/hoplon`) that implements `scanText(text, filename, configPath?)`.

### `parseGitleaksOutput(rawOutput)`

Exported for testing and advanced use. Parses a raw gitleaks JSON stdout string into `GitleaksFinding[]`.
Throws `ParseOutputError` on malformed input.

## How scanning works

For each `scanText(text, filename, configPath?)` call:

1. A unique temporary directory is created.
2. `text` is written to `<tempDir>/<basename(filename)>`.
3. `gitleaks detect --no-git --source <tempDir> --report-format json --report-path -` is invoked.
4. stdout JSON is parsed into `GitleaksFinding[]` objects.
5. The temp directory is cleaned up.
6. Findings are returned sorted by `lineNumber` ascending (then `ruleId` for ties).

Exit code 1 from gitleaks means "findings found" and is treated as success.
Any other non-zero exit code returns an empty array (non-blocking contract).

## Running tests

```bash
# Unit tests (parse output only — no binary required)
npm run test:unit

# Integration tests (requires gitleaks on PATH)
RUN_INTEGRATION=1 npm run test:integration
```
