import { describe, expect, it, beforeAll } from 'vitest';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { DeclarativeInvariantBinding } from '../../src/hoplon/contracts/invariantBinding.js';
import { evaluateInvariantBindings } from '../../src/hoplon/operations/invariantBinding.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

let codeIntelligence: CodeIntelligenceAdapter;

beforeAll(async () => {
  codeIntelligence = await createTreeSitterIntelligence({
    grammarsDir: GRAMMARS_DIR,
  });
}, 30_000);

const CONTENT = `
export async function loadUser(): Promise<Response> {
  return fetch('/user');
}

export interface UserDto {
  id: string;
  name: string;
}

export const toolContract = {
  route: '/user',
  method: 'GET',
};
`;

function run(invariants: readonly DeclarativeInvariantBinding[]) {
  return evaluateInvariantBindings({
    codeIntelligence,
    changes: [{ file: 'src/api.ts', content: CONTENT }],
    invariants,
  });
}

describe('evaluateInvariantBindings', () => {
  it('proves the supported narrow invariant kinds without enabling blocking', async () => {
    const report = await run([
      {
        id: 'export-loadUser',
        kind: 'exported_symbol_exists',
        file: 'src/api.ts',
        symbolName: 'loadUser',
        expectedNodeKind: 'function_declaration',
      },
      {
        id: 'shape-loadUser',
        kind: 'function_shape',
        target: { file: 'src/api.ts', symbolPath: ['loadUser'] },
        async: true,
        returnAnnotation: 'Promise<Response>',
      },
      {
        id: 'dto-user-id',
        kind: 'dto_field_presence',
        target: { file: 'src/api.ts', symbolPath: ['UserDto'] },
        fieldName: 'id',
      },
      {
        id: 'tool-contract',
        kind: 'route_tool_contract_shape',
        target: { file: 'src/api.ts', symbolPath: ['toolContract'] },
        requiredFields: ['route', 'method'],
      },
    ]);

    expect(report.blockingEnabled).toBe(false);
    expect(report.results.map((r) => [r.invariantId, r.status])).toEqual([
      ['dto-user-id', 'PROVED'],
      ['export-loadUser', 'PROVED'],
      ['shape-loadUser', 'PROVED'],
      ['tool-contract', 'PROVED'],
    ]);
    expect(report.results.every((r) => r.blocking === false)).toBe(true);
    expect(report.results.every((r) => r.provenance?.sourceHash.startsWith('sha256:'))).toBe(true);
  });

  it('returns typed rejections, unsupported, and stale/no-verdict results', async () => {
    const report = await run([
      {
        id: 'missing-export',
        kind: 'exported_symbol_exists',
        file: 'src/api.ts',
        symbolName: 'deleteUser',
      },
      {
        id: 'missing-dto-field',
        kind: 'dto_field_presence',
        target: { file: 'src/api.ts', symbolPath: ['UserDto'] },
        fieldName: 'email',
      },
      {
        id: 'unsupported-kind',
        kind: 'unsupported',
        requestedKind: 'natural_language_claim',
      },
      {
        id: 'stale-target',
        kind: 'function_shape',
        target: {
          file: 'src/api.ts',
          symbolPath: ['loadUser'],
          sourceHash: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
        },
        async: true,
      },
      {
        id: 'not-in-preview',
        kind: 'dto_field_presence',
        target: { file: 'src/other.ts', symbolPath: ['OtherDto'] },
        fieldName: 'id',
      },
    ]);

    expect(report.results.map((r) => [r.invariantId, r.status, r.reason])).toEqual([
      ['missing-dto-field', 'REJECTED', 'missing_field'],
      ['missing-export', 'REJECTED', 'missing_export'],
      ['not-in-preview', 'NO_VERDICT', 'target_not_in_preview'],
      ['stale-target', 'NO_VERDICT', 'target_identity_stale'],
      ['unsupported-kind', 'UNSUPPORTED', 'unsupported_invariant_kind'],
    ]);
  });
});
