import { describe, expect, it, beforeAll } from 'vitest';
import { resolve } from 'node:path';

import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import {
  createTreeSitterIntelligence,
  type RefinedSyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence/treeSitter.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import { queryStructure } from '../../src/hoplon/operations/queryStructure.js';

const GRAMMARS_DIR = resolve(process.cwd(), 'vendor', 'grammars');

let fullParseAdapter: CodeIntelligenceAdapter;
let incrementalAdapter: CodeIntelligenceAdapter;

beforeAll(async () => {
  fullParseAdapter = await createTreeSitterIntelligence({
    grammarsDir: GRAMMARS_DIR,
  });
  incrementalAdapter = await createTreeSitterIntelligence({
    grammarsDir: GRAMMARS_DIR,
    enableIncrementalParse: true,
  });
}, 30_000);

function enc(text: string): Uint8Array {
  return new TextEncoder().encode(text);
}

describe('TreeSitterParseSession — t-122 internal seam', () => {
  it('keeps public parse and symbol output equivalent to full parse after an edit', async () => {
    const before = 'export function alpha() { return 1; }\n';
    const after = 'export function alpha() { return 42; }\n';

    await incrementalAdapter.parse('src/a.ts', enc(before));
    const incrementalTree = await incrementalAdapter.parse('src/a.ts', enc(after));
    const fullTree = await fullParseAdapter.parse('src/a.ts', enc(after));

    expect((incrementalTree as RefinedSyntaxTree).language).toBe(
      (fullTree as RefinedSyntaxTree).language,
    );
    expect((incrementalTree as RefinedSyntaxTree).grammarVersion).toBe(
      (fullTree as RefinedSyntaxTree).grammarVersion,
    );
    expect(incrementalAdapter.getTopLevelSymbols(incrementalTree)).toEqual(
      fullParseAdapter.getTopLevelSymbols(fullTree),
    );
  });

  it('falls back to full-parse-equivalent public ranges for multibyte edits', async () => {
    const before = 'export const label = "alpha";\n';
    const after = 'export const label = "雪-alpha";\n';

    await incrementalAdapter.parse('src/utf8.ts', enc(before));
    const incrementalTree = await incrementalAdapter.parse('src/utf8.ts', enc(after));
    const fullTree = await fullParseAdapter.parse('src/utf8.ts', enc(after));

    expect(incrementalAdapter.getTopLevelSymbols(incrementalTree)).toEqual(
      fullParseAdapter.getTopLevelSymbols(fullTree),
    );
  });

  it('preserves queryStructure flat and grouped capture output', async () => {
    const fs = createMemFsAdapter();
    const before = 'function alpha() { return 1; }\n';
    const after = 'function alpha() { return 2; }\n';
    await fs.write('src/a.js', enc(before));
    await incrementalAdapter.parse('src/a.js', enc(before));
    await fs.write('src/a.js', enc(after));

    const deps = {
      fs,
      codeIntelligence: incrementalAdapter,
      emitter: createMemoryEmitter(),
      engineId: 't-122-test',
      root: '/',
      config: { maxFileBytes: 1024 * 1024, parseTimeoutMs: 5000 },
    };
    const result = await queryStructure(deps, {
      projectId: 'proj-t122',
      runId: 'run-t122',
      correlationId: 'corr-t122',
      files: ['src/a.js'],
      queries: [
        {
          id: 'function-name-and-body',
          language: 'javascript',
          pattern:
            '(function_declaration name: (identifier) @name body: (statement_block) @body)',
        },
      ],
    });

    expect(result.failures).toEqual([]);
    expect(result.matches.map((match) => match.captureName)).toEqual([
      'name',
      'body',
    ]);
    expect(result.matchGroups?.[0]?.captures.map((c) => c.captureName)).toEqual([
      'name',
      'body',
    ]);
  });
});
