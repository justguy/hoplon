import { createRequire } from 'node:module';

interface Picomatch {
  (pattern: string, options?: { dot?: boolean }): (path: string) => boolean;
}

const require = createRequire(import.meta.url);
const loadedPicomatch = require('picomatch') as
  | Picomatch
  | { default?: Picomatch };

function getPicomatch(): Picomatch {
  if (typeof loadedPicomatch === 'function') return loadedPicomatch;
  if (typeof loadedPicomatch.default === 'function') {
    return loadedPicomatch.default;
  }
  throw new Error('picomatch not available');
}

export function pathMatchesAllowlist(
  path: string,
  allowlist: readonly string[],
): boolean {
  if (allowlist.length === 0) return false;
  const picomatch = getPicomatch();
  for (const pattern of allowlist) {
    if (picomatch(pattern, { dot: true })(path)) return true;
  }
  return false;
}
