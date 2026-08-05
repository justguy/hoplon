/** t-120 syntax-node lookup operation proof. */

import { describe, it, expect, beforeAll } from 'vitest';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { dirname } from 'node:path';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { createTreeSitterIntelligence } from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { findSyntaxNode, type FindSyntaxNodeDeps } from '../../src/hoplon/operations/findSyntaxNode.js';
import type { FindSyntaxNodeRequest } from '../../src/hoplon/contracts/syntaxNodeLookup.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const GRAMMARS_DIR = resolve(__dirname, '..', '..', 'vendor', 'grammars');

function enc(s: string): Uint8Array {
  return new TextEncoder().encode(s);
}

let sharedCI: CodeIntelligenceAdapter;

beforeAll(async () => {
  sharedCI = await createTreeSitterIntelligence({ grammarsDir: GRAMMARS_DIR });
}, 30_000);

function makeDeps(): { deps: FindSyntaxNodeDeps; fs: ReturnType<typeof createMemFsAdapter> } {
  const fs = createMemFsAdapter();
  const deps: FindSyntaxNodeDeps = {
    fs,
    codeIntelligence: sharedCI,
    emitter: createMemoryEmitter(),
    engineId: 'test-find-node',
    root: '/',
    config: { maxFileBytes: 1024 * 1024, parseTimeoutMs: 5000 },
  };
  return { deps, fs };
}

function req(overrides: Partial<FindSyntaxNodeRequest>): FindSyntaxNodeRequest {
  return {
    projectId: 'proj-node',
    runId: 'run-node',
    correlationId: 'corr-node',
    file: 'src/a.ts',
    target: { type: 'byte_offset', byteOffset: 0, namedOnly: true },
    ...overrides,
  };
}

describe('findSyntaxNode', () => {
  it('resolves a UTF-8 byte offset to a typed node DTO', async () => {
    const { deps, fs } = makeDeps();
    const source = 'const café = 1;\nfunction done() { return café; }\n';
    await fs.write('src/a.ts', enc(source));
    const byteOffset = Buffer.byteLength('const café = 1;\nfunction ', 'utf8');

    const result = await findSyntaxNode(deps, req({
      target: { type: 'byte_offset', byteOffset, namedOnly: true },
      includeText: true,
    }));

    expect(result.status).toBe('FOUND');
    expect(result.advisory).toBe(true);
    expect(result.node?.kind).toBe('identifier');
    expect(result.node?.text).toBe('done');
    expect(result.node?.byteRange[0]).toBe(byteOffset);
    expect(result.ancestors.map((n) => n.kind)).toContain('function_declaration');
    expect(result.parserStatus.status).toBe('OK');
    expect(result.parserStatus.errorNodes).toEqual([]);
  });

  it('resolves row and UTF-8 column positions', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('const café = 1;\nfunction done() {}\n'));

    const result = await findSyntaxNode(deps, req({
      target: { type: 'position', position: { row: 1, column: 9 }, namedOnly: true },
      includeText: true,
    }));

    expect(result.status).toBe('FOUND');
    expect(result.node?.text).toBe('done');
  });

  it('returns typed failures for unsupported and missing files', async () => {
    const { deps } = makeDeps();

    const unsupported = await findSyntaxNode(deps, req({ file: 'README.md' }));
    const missing = await findSyntaxNode(deps, req({ file: 'src/missing.ts' }));

    expect(unsupported.status).toBe('UNSUPPORTED_FILE');
    expect(unsupported.parserStatus.status).toBe('UNAVAILABLE');
    expect(missing.status).toBe('FILE_NOT_FOUND');
    expect(missing.failureReason).toBe('file_not_found');
  });

  it('surfaces syntax recovery as advisory parser health', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('function broken( { return 1;'));

    const result = await findSyntaxNode(deps, req({
      target: { type: 'byte_offset', byteOffset: 0, namedOnly: true },
    }));

    expect(result.status).toBe('FOUND');
    expect(result.parserStatus.advisory).toBe(true);
    expect(result.parserStatus.status).toBe('SYNTAX_RECOVERED');
    expect(result.parserStatus.hasError).toBe(true);
    expect(result.parserStatus.errorNodes.length + result.parserStatus.missingNodes.length).toBeGreaterThan(0);
  });

  it('rejects offsets inside a multi-byte character boundary', async () => {
    const { deps, fs } = makeDeps();
    await fs.write('src/a.ts', enc('const café = 1;\n'));

    const result = await findSyntaxNode(deps, req({
      target: { type: 'byte_offset', byteOffset: Buffer.byteLength('const caf', 'utf8') + 1 },
    }));

    expect(result.status).toBe('INVALID_TARGET');
    expect(result.failureReason).toBe('invalid_utf8_byte_boundary');
  });
});
