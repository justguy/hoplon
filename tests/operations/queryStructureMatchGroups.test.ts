import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { queryStructure } from '../../src/hoplon/operations/queryStructure.js';
import type { QueryStructureDeps } from '../../src/hoplon/operations/queryStructure.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import type { QueryStructureRequest } from '../../src/hoplon/contracts/queryStructure.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(__dirname, '..', '..');
const GRAMMARS_DIR = resolve(REPO_ROOT, 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeDeps(): {
  deps: QueryStructureDeps;
  fs: ReturnType<typeof createMemFsAdapter>;
} {
  const fs = createMemFsAdapter();
  const deps: QueryStructureDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter: createMemoryEmitter(),
    engineId: 'test-qs-groups-engine',
    root: '/',
    config: { maxFileBytes: 1024 * 1024, parseTimeoutMs: 5000 },
  };
  return { deps, fs };
}

function makeReq(overrides: Partial<QueryStructureRequest> = {}): QueryStructureRequest {
  return {
    projectId: 'proj-qs-groups-test',
    runId: 'run-qs-groups-001',
    correlationId: 'corr-qs-groups-001',
    files: ['src/a.js'],
    queries: [
      {
        id: 'function-name-and-body',
        language: 'javascript',
        pattern: '(function_declaration name: (identifier) @name body: (statement_block) @body)',
      },
    ],
    ...overrides,
  };
}

describe('queryStructure grouped match output', () => {
  it('returns grouped Query.matches records while preserving flat captures', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.js', enc('function alpha() { return 1; }'));

    const result = await queryStructure(deps, makeReq());

    expect(result.failures).toHaveLength(0);
    expect(result.matches.map((match) => match.captureName)).toEqual(['name', 'body']);
    expect(result.matchGroups).toHaveLength(1);

    const group = result.matchGroups?.[0];
    expect(group).toBeDefined();
    expect(group?.queryId).toBe('function-name-and-body');
    expect(group?.path).toBe('src/a.js');
    expect(group?.patternIndex).toBe(0);
    expect(group?.matchId).toBe('src/a.js#function-name-and-body#0#0');
    expect(group?.captures.map((capture) => capture.captureName)).toEqual(['name', 'body']);
    expect(group?.captures.map((capture) => capture.matchId)).toEqual([
      group?.matchId,
      group?.matchId,
    ]);
  });

  it('adds field-aware capture metadata without raw tree-sitter handles', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.js', enc('function alpha() { return 1; }'));

    const result = await queryStructure(deps, makeReq());
    const nameCapture = result.matchGroups?.[0]?.captures.find(
      (capture) => capture.captureName === 'name',
    );

    expect(nameCapture).toBeDefined();
    expect(nameCapture?.fieldName).toBe('name');
    expect(nameCapture?.fieldPath).toContain('name');
    expect(Object.keys(nameCapture ?? {})).not.toContain('node');
    expect(Object.keys(nameCapture ?? {})).not.toContain('fieldId');
  });

  it('keeps grouped output empty for language mismatch compatibility', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('function alpha(): void {}'));

    const result = await queryStructure(deps, makeReq({ files: ['src/a.ts'] }));

    expect(result.matches).toHaveLength(0);
    expect(result.matchGroups).toEqual([]);
    expect(result.failures).toHaveLength(0);
  });
});
