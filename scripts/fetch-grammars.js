#!/usr/bin/env node
/**
 * scripts/fetch-grammars.js
 *
 * Postinstall script: stages tree-sitter WASM grammar files from node_modules
 * into vendor/grammars/ and verifies sha256 against the pinned manifest.
 *
 * Sources:
 *   - Reads vendor/grammars/MANIFEST.json for pinned { url, sha256, size } entries.
 *   - URL scheme "npm:<package>@<version>/<file>" is resolved to node_modules/.
 *   - All I/O is synchronous — no network requests; grammars come from installed
 *     npm packages, not a remote CDN.
 *
 * Behavior:
 *   - File already present AND sha256 matches → skip (idempotent).
 *   - File present BUT sha256 does NOT match → fail loudly; do NOT overwrite
 *     (silent overwrite could mask supply-chain tampering or corruption).
 *   - HOPLON_OFFLINE=1 in env → skip all staging; assume grammars are pre-staged.
 *   - Exit 0 on success. Non-zero on hash mismatch or any staging failure.
 *
 * This file is intentionally plain ES module with no TypeScript and no
 * third-party imports so it runs as `node scripts/fetch-grammars.js` without
 * compilation.
 */

import { createHash } from 'node:crypto';
import { readFileSync, existsSync, writeFileSync, mkdirSync, renameSync, unlinkSync } from 'node:fs';
import { createRequire } from 'node:module';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(__dirname, '..');
const VENDOR_DIR = join(ROOT, 'vendor', 'grammars');
const MANIFEST_PATH = join(VENDOR_DIR, 'MANIFEST.json');
const require = createRequire(import.meta.url);
const packageRootCache = new Map();

// ---------------------------------------------------------------------------
// Offline mode
// ---------------------------------------------------------------------------

if (process.env['HOPLON_OFFLINE'] === '1') {
  console.log('[fetch-grammars] HOPLON_OFFLINE=1 — skipping grammar staging. Assuming grammars are pre-staged.');
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Load manifest
// ---------------------------------------------------------------------------

/** @type {{ grammars: Record<string, { url: string; sha256: string; size: number; sourcePackage: string; sourceVersion: string; sourceFile: string }> }} */
let manifest;
try {
  manifest = JSON.parse(readFileSync(MANIFEST_PATH, 'utf8'));
} catch (err) {
  console.error(
    `[fetch-grammars] Failed to read manifest at ${MANIFEST_PATH}: ${err instanceof Error ? err.message : String(err)}`
  );
  process.exit(1);
}

const entries = Object.entries(manifest.grammars);

// ---------------------------------------------------------------------------
// Ensure vendor/grammars directory exists
// ---------------------------------------------------------------------------

mkdirSync(VENDOR_DIR, { recursive: true });

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** @param {Buffer} buf @returns {string} */
function sha256hex(buf) {
  return createHash('sha256').update(buf).digest('hex');
}

/**
 * Resolve "npm:<package>@<version>/<file>" to an absolute path in node_modules.
 * Supports scoped packages (@scope/name@version/file).
 *
 * @param {string} url
 * @returns {string}
 */
function resolveNpmUrl(url) {
  if (!url.startsWith('npm:')) {
    throw new Error(`Unsupported URL scheme: "${url}". Only npm: URLs are supported.`);
  }
  const rest = url.slice('npm:'.length);

  // Locate the @<version> separator. Scoped packages start with @, so skip idx 0.
  const atVersionIdx = rest.indexOf('@', rest.startsWith('@') ? 1 : 0);
  if (atVersionIdx === -1) {
    throw new Error(`Cannot parse npm URL — missing @<version> in "${url}"`);
  }

  const packageName = rest.slice(0, atVersionIdx);
  const afterAt = rest.slice(atVersionIdx + 1); // "<version>/<file>"
  const slashIdx = afterAt.indexOf('/');
  if (slashIdx === -1) {
    throw new Error(`Cannot parse npm URL — missing file path after version in "${url}"`);
  }

  const filePath = afterAt.slice(slashIdx + 1);
  return join(resolveInstalledPackageRoot(packageName), filePath);
}

/**
 * Resolve an installed package to its real package root, even when npm hoists
 * it outside this package's own node_modules directory.
 *
 * @param {string} packageName
 * @returns {string}
 */
function resolveInstalledPackageRoot(packageName) {
  if (packageRootCache.has(packageName)) {
    return packageRootCache.get(packageName);
  }

  let entryPath;
  try {
    entryPath = require.resolve(packageName, { paths: [ROOT] });
  } catch (err) {
    throw new Error(
      `Cannot resolve package "${packageName}" from ${ROOT}: ${err instanceof Error ? err.message : String(err)}`
    );
  }

  let currentDir = dirname(entryPath);
  let previousDir = '';

  while (currentDir !== previousDir) {
    if (existsSync(join(currentDir, 'package.json'))) {
      packageRootCache.set(packageName, currentDir);
      return currentDir;
    }
    previousDir = currentDir;
    currentDir = dirname(currentDir);
  }

  throw new Error(`Resolved "${packageName}" to "${entryPath}" but could not find its package root.`);
}

// ---------------------------------------------------------------------------
// Stage each grammar
// ---------------------------------------------------------------------------

let failed = false;

for (const [name, entry] of entries) {
  const dest = join(VENDOR_DIR, name);
  const expectedHash = entry.sha256;
  const expectedSize = entry.size;

  // --- Already staged? ---
  if (existsSync(dest)) {
    const existing = readFileSync(dest);
    const actualHash = sha256hex(existing);
    if (actualHash === expectedHash) {
      console.log(`[fetch-grammars] ${name}: already present and verified — skipping.`);
      continue;
    }
    console.error(
      `[fetch-grammars] FATAL: ${name} exists but sha256 mismatch.\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${actualHash}\n` +
        `  Refusing to overwrite — this may indicate corruption or tampering.\n` +
        `  To re-stage: delete ${dest} and run this script again.`
    );
    failed = true;
    continue;
  }

  // --- Resolve source in node_modules ---
  let sourcePath;
  try {
    sourcePath = resolveNpmUrl(entry.url);
  } catch (err) {
    console.error(
      `[fetch-grammars] ${name}: failed to resolve URL "${entry.url}": ${err instanceof Error ? err.message : String(err)}`
    );
    failed = true;
    continue;
  }

  if (!existsSync(sourcePath)) {
    console.error(
      `[fetch-grammars] FATAL: ${name}: source file not found at ${sourcePath}.\n` +
        `  Expected from "${entry.url}".\n` +
        `  Ensure ${entry.sourcePackage}@${entry.sourceVersion} is installed.\n` +
        `  Run: npm install ${entry.sourcePackage}@${entry.sourceVersion}`
    );
    failed = true;
    continue;
  }

  // --- Read and verify sha256 + size ---
  const content = readFileSync(sourcePath);
  const actualHash = sha256hex(content);

  if (actualHash !== expectedHash) {
    console.error(
      `[fetch-grammars] FATAL: ${name}: sha256 mismatch after reading from node_modules.\n` +
        `  source:   ${sourcePath}\n` +
        `  expected: ${expectedHash}\n` +
        `  actual:   ${actualHash}\n` +
        `  The installed package does not match the pinned manifest.\n` +
        `  Update vendor/grammars/MANIFEST.json if you intentionally upgraded.`
    );
    failed = true;
    continue;
  }

  if (content.length !== expectedSize) {
    console.error(
      `[fetch-grammars] FATAL: ${name}: size mismatch.\n` +
        `  expected: ${expectedSize} bytes\n` +
        `  actual:   ${content.length} bytes`
    );
    failed = true;
    continue;
  }

  // --- Write atomically: tmp → rename ---
  const tmp = `${dest}.tmp_${process.pid}`;
  try {
    writeFileSync(tmp, content);
    renameSync(tmp, dest);
    console.log(`[fetch-grammars] ${name}: staged ${content.length} bytes (sha256 verified).`);
  } catch (err) {
    // Best-effort cleanup of tmp
    try { unlinkSync(tmp); } catch { /* ignore */ }
    console.error(
      `[fetch-grammars] ${name}: write failed: ${err instanceof Error ? err.message : String(err)}`
    );
    failed = true;
  }
}

if (failed) {
  console.error('[fetch-grammars] One or more grammars failed to stage. See errors above.');
  process.exit(1);
}

console.log('[fetch-grammars] All grammars present and verified.');
