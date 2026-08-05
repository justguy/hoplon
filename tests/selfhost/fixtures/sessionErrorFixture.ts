import * as fs from 'node:fs';
import * as path from 'node:path';

import type { WritableManifest } from '../../../src/hoplon/contracts/manifest.js';

export const CONTRACTED_PATH = 'src/hoplon/session/errors.ts';
export const CONTRACTED_SYMBOLS = ['SessionError'] as const;

export const SESSION_ERROR_SINGLE_SYMBOL_BASELINE = `export type SessionErrorKind =
  | 'invalid_state_transition'
  | 'session_closed';

export class SessionError extends Error {
  readonly kind: SessionErrorKind;

  constructor(kind: SessionErrorKind) {
    super(\`Hoplon session: \${kind}\`);
    this.name = 'SessionError';
    this.kind = kind;
  }
}
`;

export function seedSessionErrorFixture(root: string): string {
  fs.mkdirSync(path.join(root, path.dirname(CONTRACTED_PATH)), {
    recursive: true,
  });
  fs.writeFileSync(
    path.join(root, CONTRACTED_PATH),
    SESSION_ERROR_SINGLE_SYMBOL_BASELINE,
  );
  return SESSION_ERROR_SINGLE_SYMBOL_BASELINE;
}

export function sessionErrorSymbolsManifest(
  projectId: string,
  file: string = CONTRACTED_PATH,
): WritableManifest {
  return {
    manifestSchemaVersion: 1,
    projectId,
    runId: `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    correlationId: `corr-${projectId}-${Date.now()}`,
    entries: [{ path: file, scope: { kind: 'symbols', symbols: [...CONTRACTED_SYMBOLS] } }],
  };
}
