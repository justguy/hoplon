#!/usr/bin/env node

import { chmodSync, existsSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const binPath = join(__dirname, '..', 'dist', 'bin', 'hoplon.js');

if (!existsSync(binPath)) {
  throw new Error(`Expected CLI build output at ${binPath}`);
}

const currentMode = statSync(binPath).mode;
chmodSync(binPath, currentMode | 0o755);
