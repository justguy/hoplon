/**
 * tests/contracts/describeProject.test.ts — Zod round-trip + invariant proof.
 */

import { describe, it, expect } from 'vitest';
import {
  DescribeProjectRequestSchema,
  DescribeProjectResultSchema,
  SUPPORTED_PROJECT_LANGUAGES,
} from '../../src/hoplon/contracts/describeProject.js';

describe('DescribeProjectRequestSchema', () => {
  it('accepts a minimal request and applies defaults', () => {
    const parsed = DescribeProjectRequestSchema.parse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
    });
    expect(parsed.maxFiles).toBe(1000);
    expect(parsed.samplePathsPerLanguage).toBe(25);
  });

  it('rejects non-positive maxFiles', () => {
    const r = DescribeProjectRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      maxFiles: 0,
    });
    expect(r.success).toBe(false);
  });

  it('caps maxFiles at the hard ceiling', () => {
    const r = DescribeProjectRequestSchema.safeParse({
      projectId: 'p',
      runId: 'r',
      correlationId: 'c',
      maxFiles: 1_000_000,
    });
    expect(r.success).toBe(false);
  });

  it('SUPPORTED_PROJECT_LANGUAGES matches the tree-sitter grammar set', () => {
    expect([...SUPPORTED_PROJECT_LANGUAGES]).toEqual(['javascript', 'typescript', 'tsx']);
  });
});

describe('DescribeProjectResultSchema', () => {
  it('accepts a well-formed result', () => {
    const r = DescribeProjectResultSchema.parse({
      files: {
        total: 3,
        byLanguage: [
          { language: 'javascript', fileCount: 1, samplePaths: ['a.js'] },
          { language: 'typescript', fileCount: 2, samplePaths: ['b.ts', 'c.ts'] },
          { language: 'tsx', fileCount: 0, samplePaths: [] },
        ],
      },
      symbols: { exports: 1, imports: 2, types: 0, functions: 3, classes: 0 },
      filesScanned: 3,
      truncated: false,
      failures: [],
    });
    expect(r.files.total).toBe(3);
  });

  it('rejects negative counts', () => {
    const r = DescribeProjectResultSchema.safeParse({
      files: { total: -1, byLanguage: [] },
      symbols: { exports: 0, imports: 0, types: 0, functions: 0, classes: 0 },
      filesScanned: 0,
      truncated: false,
      failures: [],
    });
    expect(r.success).toBe(false);
  });

  it('accepts surfaced sampled-file failures', () => {
    const r = DescribeProjectResultSchema.parse({
      files: {
        total: 2,
        byLanguage: [
          { language: 'javascript', fileCount: 0, samplePaths: [] },
          { language: 'typescript', fileCount: 2, samplePaths: ['a.ts', 'b.ts'] },
          { language: 'tsx', fileCount: 0, samplePaths: [] },
        ],
      },
      symbols: { exports: 1, imports: 0, types: 0, functions: 1, classes: 0 },
      filesScanned: 2,
      truncated: false,
      failures: [
        {
          path: 'b.ts',
          reason: 'parse_failure',
          message: 'Failed to parse source file',
        },
      ],
    });
    expect(r.failures).toHaveLength(1);
  });
});
