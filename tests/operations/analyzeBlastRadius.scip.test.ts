import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { describe, expect, it } from 'vitest';

import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import type { AnalyzeBlastRadiusDeps } from '../../src/hoplon/operations/analyzeBlastRadius.js';
import { analyzeBlastRadius } from '../../src/hoplon/operations/analyzeBlastRadius.js';
import type { CodeIntelligenceAdapter } from '../../src/hoplon/adapters/codeIntelligence.js';
import {
  ScipIndexStaleError,
  createScipCodeIntelligence,
  createScipProvider,
  type ScipSnapshot,
} from '../../packages/code-intelligence-scip/src/index.js';

function createFallback(): CodeIntelligenceAdapter {
  return {
    async parse() {
      return { rootNode: { kind: 'program', children: [] } };
    },
    getTopLevelSymbols() {
      return [];
    },
  };
}

async function writeSnapshot(snapshot: ScipSnapshot): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'hoplon-scip-'));
  const path = join(dir, 'index.scip.json');
  await writeFile(path, JSON.stringify(snapshot), 'utf8');
  return path;
}

function makeDeps(codeIntelligence: CodeIntelligenceAdapter): AnalyzeBlastRadiusDeps {
  return {
    codeIntelligence,
    emitter: createMemoryEmitter(),
    engineId: 'engine-br-scip',
  };
}

describe('analyzeBlastRadius with SCIP-backed code intelligence', () => {
  it('uses the offline index through the existing advisory findReferences seam', async () => {
    const indexPath = await writeSnapshot({
      snapshotSchemaVersion: 1,
      metadata: {
        schemaVersion: 1,
        providerVersion: 'scip-test-provider',
        workspaceRevision: 'rev-1',
        generatedAt: '2026-04-18T00:00:00Z',
      },
      documents: [
        {
          path: '/proj/src/createSession.ts',
          dependencies: ['/proj/src/contracts.ts'],
          occurrences: [
            { symbol: 'createSession', role: 'definition', byteRange: [0, 13] },
          ],
        },
        {
          path: '/proj/src/api.ts',
          dependencies: ['/proj/src/createSession.ts'],
          occurrences: [
            { symbol: 'createSession', role: 'reference', byteRange: [20, 33] },
          ],
        },
        {
          path: '/proj/tests/createSession.test.ts',
          dependencies: ['/proj/src/createSession.ts'],
          occurrences: [
            { symbol: 'createSession', role: 'reference', byteRange: [15, 28] },
          ],
        },
      ],
    });

    const codeIntelligence = createScipCodeIntelligence({
      provider: createScipProvider({
        indexPath,
        workspaceRevision: 'rev-1',
      }),
      fallbackAdapter: createFallback(),
    });

    const result = await analyzeBlastRadius(
      makeDeps(codeIntelligence),
      {
        correlationId: 'corr-br-scip',
        projectId: 'proj-scip',
        warnThreshold: 2,
        symbols: [
          {
            name: 'createSession',
            kind: 'function',
            byteRange: [0, 13],
          },
        ],
      },
    );

    expect(result.advisory).toBe(true);
    expect(result.providerAvailable).toBe(true);
    expect(result.status).toBe('WARNING');
    expect(result.entries[0]?.classification).toBe('warning');
    expect(result.entries[0]?.referenceCount).toBe(2);
    expect(result.entries[0]?.affectedFiles).toEqual([
      '/proj/src/api.ts',
      '/proj/tests/createSession.test.ts',
    ]);
  });

  it('keeps stale index state explicit instead of fabricating blast-radius results', async () => {
    const indexPath = await writeSnapshot({
      snapshotSchemaVersion: 1,
      metadata: {
        schemaVersion: 1,
        providerVersion: 'scip-test-provider',
        workspaceRevision: 'rev-1',
        generatedAt: '2026-04-18T00:00:00Z',
      },
      documents: [
        {
          path: '/proj/src/createSession.ts',
          dependencies: [],
          occurrences: [
            { symbol: 'createSession', role: 'definition', byteRange: [0, 13] },
          ],
        },
      ],
    });

    const codeIntelligence = createScipCodeIntelligence({
      provider: createScipProvider({
        indexPath,
        workspaceRevision: 'rev-2',
      }),
      fallbackAdapter: createFallback(),
    });

    await expect(
      analyzeBlastRadius(makeDeps(codeIntelligence), {
        correlationId: 'corr-br-scip-stale',
        projectId: 'proj-scip',
        symbols: [
          {
            name: 'createSession',
            kind: 'function',
            byteRange: [0, 13],
          },
        ],
      }),
    ).rejects.toBeInstanceOf(ScipIndexStaleError);
  });
});
