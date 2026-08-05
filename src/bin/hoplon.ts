#!/usr/bin/env node
/**
 * bin/hoplon.ts — `hoplon` CLI entry point.
 *
 * Delegates all parsing and dispatch to launcher/cli.ts. This file stays
 * tiny so it never drifts from the programmatic launcher entry points.
 */

import { runCli } from '../hoplon/launcher/cli.js';
import { createLauncherSemanticRuntime } from './semanticRuntime.js';

const PACKAGE_VERSION = '0.4.0';

runCli(
  process.argv.slice(2),
  {
    stdout: (line) => process.stdout.write(line + '\n'),
    stderr: (line) => process.stderr.write(line + '\n'),
    version: PACKAGE_VERSION,
  },
  {
    semanticRuntime: createLauncherSemanticRuntime,
  },
)
  .then((code) => process.exit(code))
  .catch((err: unknown) => {
    const message = err instanceof Error ? err.message : String(err);
    process.stderr.write(`hoplon: fatal: ${message}\n`);
    process.exit(1);
  });
