import { describe, expect, it } from 'vitest';

import { buildIndexSemanticCorpusRequestFromBoundary } from '../../src/hoplon/operations/semanticProjectCorpus.js';

const enc = new TextEncoder();

describe('semantic project corpus request builder', () => {
  it('converts boundary documents into an indexSemanticCorpus request', () => {
    const built = buildIndexSemanticCorpusRequestFromBoundary({
      status: 'AVAILABLE',
      projectId: 'project-alpha',
      correlationId: 'corr-sem-project-001',
      fsRootIdentityHash: 'sha256:root-alpha',
      headOid: 'head-alpha',
      documents: [
        {
          identity: {
            canonicalProjectRelativePath: 'src/alpha.ts',
            fsRootIdentityHash: 'sha256:root-alpha',
          },
          bytes: enc.encode('export const alpha = "semantic runtime";\n'),
          worktreeState: 'dirty',
        },
      ],
      resultCount: 1,
      excludedCount: 0,
      degradationReasons: [],
    }, {
      worktreeId: 'worktree-alpha',
      ignoreRulesHash: 'ignore-alpha',
    });

    expect(built.skippedEmptyDocumentCount).toBe(0);
    expect(built.request).toMatchObject({
      projectId: 'project-alpha',
      correlationId: 'corr-sem-project-001',
      indexContext: {
        worktreeId: 'worktree-alpha',
        headOid: 'head-alpha',
        ignoreRulesHash: 'ignore-alpha',
      },
      documents: [
        {
          id: 'src/alpha.ts',
          text: 'export const alpha = "semantic runtime";\n',
          metadata: {
            path: 'src/alpha.ts',
            fsRootIdentityHash: 'sha256:root-alpha',
            worktreeState: 'dirty',
            headOid: 'head-alpha',
          },
        },
      ],
    });
  });

  it('returns null instead of building an invalid empty-documents request', () => {
    const built = buildIndexSemanticCorpusRequestFromBoundary({
      status: 'EMPTY',
      projectId: 'project-alpha',
      correlationId: 'corr-sem-project-002',
      fsRootIdentityHash: 'sha256:root-alpha',
      headOid: null,
      documents: [
        {
          identity: {
            canonicalProjectRelativePath: 'empty.txt',
            fsRootIdentityHash: 'sha256:root-alpha',
          },
          bytes: enc.encode('\n'),
          worktreeState: 'clean',
        },
      ],
      resultCount: 1,
      excludedCount: 0,
      degradationReasons: [],
    });

    expect(built).toEqual({
      request: null,
      skippedEmptyDocumentCount: 1,
    });
  });
});
