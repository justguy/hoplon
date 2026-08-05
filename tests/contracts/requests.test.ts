/**
 * Contract tests for request DTO schemas.
 *
 * Proves each of 4 request DTOs validates correctly and rejects missing
 * required fields.
 */

import { describe, it, expect } from 'vitest';
import {
  CreateSnapshotRequestSchema,
  AuditRequestSchema,
  RevertRequestSchema,
  PackContextRequestSchema,
  ProposedChangeSchema,
  FullFileProposedChangeSchema,
  PatchProposedChangeSchema,
  StructuralProposedChangeSchema,
  DryRunRequestSchema,
} from '../../src/hoplon/contracts/requests.js';

// ---------------------------------------------------------------------------
// CreateSnapshotRequest
// ---------------------------------------------------------------------------

const VALID_MANIFEST = {
  manifestSchemaVersion: 1 as const,
  projectId: 'test-project',
  runId: 'run-001',
  correlationId: 'corr-001',
  entries: [{ path: 'src/util/format.ts', scope: { kind: 'whole_file' as const } }],
};

describe('CreateSnapshotRequest', () => {
  it('accepts a valid request', () => {
    expect(
      CreateSnapshotRequestSchema.safeParse({ manifest: VALID_MANIFEST }).success,
    ).toBe(true);
  });

  it('rejects missing manifest', () => {
    expect(CreateSnapshotRequestSchema.safeParse({}).success).toBe(false);
  });

  it('rejects manifest with missing manifestSchemaVersion', () => {
    const { manifestSchemaVersion: _v, ...withoutVersion } = VALID_MANIFEST;
    expect(
      CreateSnapshotRequestSchema.safeParse({ manifest: withoutVersion }).success,
    ).toBe(false);
  });

  it('rejects manifest with missing runId', () => {
    const { runId: _r, ...withoutRun } = VALID_MANIFEST;
    expect(
      CreateSnapshotRequestSchema.safeParse({ manifest: withoutRun }).success,
    ).toBe(false);
  });

  it('rejects manifest with missing correlationId', () => {
    const { correlationId: _c, ...withoutCorr } = VALID_MANIFEST;
    expect(
      CreateSnapshotRequestSchema.safeParse({ manifest: withoutCorr }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// AuditRequest
// ---------------------------------------------------------------------------

const VALID_AUDIT_REQ = {
  snapshotRefId: 'a'.repeat(64),
  projectId: 'test-project',
  runId: 'run-001',
  correlationId: 'corr-001',
  files: ['src/util/format.ts'],
};

describe('AuditRequest', () => {
  it('accepts a valid request', () => {
    expect(AuditRequestSchema.safeParse(VALID_AUDIT_REQ).success).toBe(true);
  });

  it('accepts empty files array', () => {
    expect(
      AuditRequestSchema.safeParse({ ...VALID_AUDIT_REQ, files: [] }).success,
    ).toBe(true);
  });

  it('rejects missing snapshotRefId', () => {
    const { snapshotRefId: _s, ...without } = VALID_AUDIT_REQ;
    expect(AuditRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing projectId', () => {
    const { projectId: _p, ...without } = VALID_AUDIT_REQ;
    expect(AuditRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing runId', () => {
    const { runId: _r, ...without } = VALID_AUDIT_REQ;
    expect(AuditRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing correlationId', () => {
    const { correlationId: _c, ...without } = VALID_AUDIT_REQ;
    expect(AuditRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing files', () => {
    const { files: _f, ...without } = VALID_AUDIT_REQ;
    expect(AuditRequestSchema.safeParse(without).success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// RevertRequest (same as AuditRequest minus files)
// ---------------------------------------------------------------------------

const VALID_REVERT_REQ = {
  snapshotRefId: 'a'.repeat(64),
  projectId: 'test-project',
  runId: 'run-001',
  correlationId: 'corr-001',
};

describe('RevertRequest', () => {
  it('accepts a valid request', () => {
    expect(RevertRequestSchema.safeParse(VALID_REVERT_REQ).success).toBe(true);
  });

  it('rejects missing snapshotRefId', () => {
    const { snapshotRefId: _s, ...without } = VALID_REVERT_REQ;
    expect(RevertRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing projectId', () => {
    const { projectId: _p, ...without } = VALID_REVERT_REQ;
    expect(RevertRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing runId', () => {
    const { runId: _r, ...without } = VALID_REVERT_REQ;
    expect(RevertRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing correlationId', () => {
    const { correlationId: _c, ...without } = VALID_REVERT_REQ;
    expect(RevertRequestSchema.safeParse(without).success).toBe(false);
  });

  it('does not have a files field (distinct from AuditRequest)', () => {
    // files is not part of RevertRequest — extra fields are accepted by Zod by default
    // but the schema itself doesn't require it
    const result = RevertRequestSchema.safeParse(VALID_REVERT_REQ);
    expect(result.success).toBe(true);
    if (result.success) {
      expect('files' in result.data).toBe(false);
    }
  });
});

// ---------------------------------------------------------------------------
// PackContextRequest
// ---------------------------------------------------------------------------

const VALID_PACK_REQ = {
  projectId: 'test-project',
  runId: 'run-001',
  correlationId: 'corr-001',
  files: ['src/util/format.ts'],
  strategy: { kind: 'whole_file' as const },
};

describe('PackContextRequest', () => {
  it('accepts a valid request with whole_file strategy', () => {
    expect(PackContextRequestSchema.safeParse(VALID_PACK_REQ).success).toBe(true);
  });

  it('accepts a valid request with symbols strategy', () => {
    expect(
      PackContextRequestSchema.safeParse({
        ...VALID_PACK_REQ,
        strategy: { kind: 'symbols', symbols: ['formatPrice'] },
      }).success,
    ).toBe(true);
  });

  it('rejects symbols strategy with empty symbols array', () => {
    expect(
      PackContextRequestSchema.safeParse({
        ...VALID_PACK_REQ,
        strategy: { kind: 'symbols', symbols: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects missing projectId', () => {
    const { projectId: _p, ...without } = VALID_PACK_REQ;
    expect(PackContextRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing correlationId', () => {
    const { correlationId: _c, ...without } = VALID_PACK_REQ;
    expect(PackContextRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing files', () => {
    const { files: _f, ...without } = VALID_PACK_REQ;
    expect(PackContextRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing strategy', () => {
    const { strategy: _s, ...without } = VALID_PACK_REQ;
    expect(PackContextRequestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects unknown strategy kind', () => {
    expect(
      PackContextRequestSchema.safeParse({
        ...VALID_PACK_REQ,
        strategy: { kind: 'unknown_strategy' },
      }).success,
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ProposedChange union (t-071)
// ---------------------------------------------------------------------------

describe('ProposedChange — full_file variant', () => {
  it('accepts the legacy shape without a kind field', () => {
    const parsed = ProposedChangeSchema.safeParse({
      file: 'src/foo.ts',
      content: 'export const x = 1;\n',
    });
    expect(parsed.success).toBe(true);
  });

  it('accepts an explicit kind: "full_file"', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({
        kind: 'full_file',
        file: 'src/foo.ts',
        content: 'x',
      }).success,
    ).toBe(true);
  });

  it('rejects missing file', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({ content: 'x' }).success,
    ).toBe(false);
  });

  it('rejects empty file', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({ file: '', content: 'x' }).success,
    ).toBe(false);
  });
});

describe('ProposedChange — patch variant', () => {
  const VALID_PATCH = {
    kind: 'patch' as const,
    file: 'src/foo.ts',
    hunks: [{ search: 'old', replace: 'new' }],
  };

  it('accepts a valid single-hunk patch', () => {
    expect(PatchProposedChangeSchema.safeParse(VALID_PATCH).success).toBe(true);
    expect(ProposedChangeSchema.safeParse(VALID_PATCH).success).toBe(true);
  });

  it('accepts a multi-hunk patch', () => {
    expect(
      ProposedChangeSchema.safeParse({
        ...VALID_PATCH,
        hunks: [
          { search: 'a', replace: 'A' },
          { search: 'b', replace: 'B' },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects empty hunks', () => {
    expect(
      PatchProposedChangeSchema.safeParse({ ...VALID_PATCH, hunks: [] }).success,
    ).toBe(false);
  });

  it('rejects a hunk with empty search anchor', () => {
    expect(
      PatchProposedChangeSchema.safeParse({
        ...VALID_PATCH,
        hunks: [{ search: '', replace: 'new' }],
      }).success,
    ).toBe(false);
  });

  it('accepts a hunk with empty replace (deletion)', () => {
    expect(
      PatchProposedChangeSchema.safeParse({
        ...VALID_PATCH,
        hunks: [{ search: 'old', replace: '' }],
      }).success,
    ).toBe(true);
  });
});

describe('ProposedChange — structural variant', () => {
  const VALID_STRUCTURAL = {
    kind: 'structural' as const,
    file: 'src/foo.ts',
    target: { symbol: 'foo' },
    content: 'export function foo() { return 1; }\n',
  };

  it('accepts a valid structural change', () => {
    expect(StructuralProposedChangeSchema.safeParse(VALID_STRUCTURAL).success).toBe(true);
    expect(ProposedChangeSchema.safeParse(VALID_STRUCTURAL).success).toBe(true);
  });

  it('rejects missing target.symbol', () => {
    const { target: _t, ...without } = VALID_STRUCTURAL;
    expect(
      StructuralProposedChangeSchema.safeParse({ ...without, target: {} }).success,
    ).toBe(false);
  });

  it('rejects empty target.symbol', () => {
    expect(
      StructuralProposedChangeSchema.safeParse({
        ...VALID_STRUCTURAL,
        target: { symbol: '' },
      }).success,
    ).toBe(false);
  });

  // -------------------------------------------------------------------------
  // t-066 — widened StructuralTarget union (nested symbolPath selector)
  // -------------------------------------------------------------------------

  it('accepts a nested symbolPath selector', () => {
    expect(
      StructuralProposedChangeSchema.safeParse({
        ...VALID_STRUCTURAL,
        target: { symbolPath: ['MyClass', 'doThing'] },
      }).success,
    ).toBe(true);
  });

  it('rejects an empty symbolPath array', () => {
    expect(
      StructuralProposedChangeSchema.safeParse({
        ...VALID_STRUCTURAL,
        target: { symbolPath: [] },
      }).success,
    ).toBe(false);
  });

  it('rejects a symbolPath entry that is empty', () => {
    expect(
      StructuralProposedChangeSchema.safeParse({
        ...VALID_STRUCTURAL,
        target: { symbolPath: ['MyClass', ''] },
      }).success,
    ).toBe(false);
  });
});

describe('StagedContentRef variants on full_file / structural (t-076)', () => {
  const VALID_STAGED_REF = {
    stagingKey: 'k-1',
    expectedSha256: 'a'.repeat(64),
    expectedByteLength: 42,
  };

  it('accepts a full_file change with stagedContent instead of content', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({
        kind: 'full_file',
        file: 'big.ts',
        stagedContent: VALID_STAGED_REF,
      }).success,
    ).toBe(true);
  });

  it('accepts a legacy no-kind full_file change with inline content', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({
        file: 'tiny.ts',
        content: 'export const x = 1;\n',
      }).success,
    ).toBe(true);
  });

  it('rejects a full_file change with both content and stagedContent', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({
        file: 'x.ts',
        content: 'x',
        stagedContent: VALID_STAGED_REF,
      }).success,
    ).toBe(false);
  });

  it('rejects a full_file change with neither content nor stagedContent', () => {
    expect(FullFileProposedChangeSchema.safeParse({ file: 'x.ts' }).success).toBe(false);
  });

  it('accepts a structural change with stagedContent', () => {
    expect(
      StructuralProposedChangeSchema.safeParse({
        kind: 'structural',
        file: 'src/mc.ts',
        target: { symbol: 'MyClass' },
        stagedContent: VALID_STAGED_REF,
      }).success,
    ).toBe(true);
  });

  it('rejects a structural change with both content and stagedContent', () => {
    expect(
      StructuralProposedChangeSchema.safeParse({
        kind: 'structural',
        file: 'src/mc.ts',
        target: { symbol: 'MyClass' },
        content: 'class MyClass {}',
        stagedContent: VALID_STAGED_REF,
      }).success,
    ).toBe(false);
  });

  it('rejects a stagedContent with a malformed sha256', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({
        file: 'x.ts',
        stagedContent: {
          stagingKey: 'k',
          expectedSha256: 'not-hex',
          expectedByteLength: 0,
        },
      }).success,
    ).toBe(false);
  });

  it('rejects a stagedContent with a negative expectedByteLength', () => {
    expect(
      FullFileProposedChangeSchema.safeParse({
        file: 'x.ts',
        stagedContent: {
          stagingKey: 'k',
          expectedSha256: 'a'.repeat(64),
          expectedByteLength: -1,
        },
      }).success,
    ).toBe(false);
  });
});

describe('DryRunRequest — accepts union variants in proposedChanges', () => {
  const base = {
    snapshotRefId: 'a'.repeat(64),
    projectId: 'p',
    runId: 'r',
    correlationId: 'c',
  };

  it('accepts a mix of all three variants', () => {
    expect(
      DryRunRequestSchema.safeParse({
        ...base,
        proposedChanges: [
          { file: 'a.ts', content: 'x' },
          { kind: 'patch', file: 'b.ts', hunks: [{ search: 'o', replace: 'n' }] },
          {
            kind: 'structural',
            file: 'c.ts',
            target: { symbol: 'foo' },
            content: 'x',
          },
        ],
      }).success,
    ).toBe(true);
  });

  it('rejects empty proposedChanges', () => {
    expect(
      DryRunRequestSchema.safeParse({ ...base, proposedChanges: [] }).success,
    ).toBe(false);
  });
});
