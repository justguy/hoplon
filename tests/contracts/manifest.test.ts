/**
 * Contract tests for WritableManifest, ManifestEntry, ManifestScope schemas.
 *
 * A3.1 updates:
 * - WritableManifest now requires manifestSchemaVersion: 1, runId, correlationId
 * - entries has max 1000
 * - path has max 4096 and Windows absolute path rejection
 *
 * SV1 updates (Phase 2 Stage A):
 * - manifestSchemaVersion now accepts 1 or 2 (additive union)
 * - ManifestEntry.intent (optional) accepts 'create' | 'modify'; other values rejected
 * - WritableManifest.signatureContracts (optional) accepted with full SignatureContract shape
 * - manifestSchemaVersion: 3 → Zod rejection (version 3+ not accepted)
 * - v1 manifests remain fully valid (backward compatible)
 */

import { describe, it, expect } from 'vitest';
import { zodToJsonSchema } from 'zod-to-json-schema';
import {
  ManifestScopeSchema,
  ManifestEntrySchema,
  WritableManifestSchema,
  SignatureContractSchema,
  SignatureParamSchema,
} from '../../src/hoplon/contracts/manifest.js';

// ---------------------------------------------------------------------------
// ManifestScope
// ---------------------------------------------------------------------------

describe('ManifestScope', () => {
  it('accepts whole_file variant', () => {
    const result = ManifestScopeSchema.safeParse({ kind: 'whole_file' });
    expect(result.success).toBe(true);
  });

  it('accepts symbols variant with at least one symbol', () => {
    const result = ManifestScopeSchema.safeParse({
      kind: 'symbols',
      symbols: ['formatPrice'],
    });
    expect(result.success).toBe(true);
  });

  it('rejects symbols variant with empty array', () => {
    const result = ManifestScopeSchema.safeParse({
      kind: 'symbols',
      symbols: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects unknown kind', () => {
    const result = ManifestScopeSchema.safeParse({ kind: 'partial_file' });
    expect(result.success).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// ManifestEntry
// ---------------------------------------------------------------------------

describe('ManifestEntry', () => {
  it('accepts valid entry with whole_file scope', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'src/util/format.ts',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(true);
  });

  it('accepts valid entry with symbols scope', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'src/types.ts',
      scope: { kind: 'symbols', symbols: ['PriceFormat'] },
    });
    expect(result.success).toBe(true);
  });

  it('rejects path with .. segment', () => {
    const result = ManifestEntrySchema.safeParse({
      path: '../outside/project.ts',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects path with embedded .. segment', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'src/../outside/project.ts',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects absolute path starting with /', () => {
    const result = ManifestEntrySchema.safeParse({
      path: '/absolute/path.ts',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Windows-style absolute path', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'C:\\Users\\file.ts',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects Windows-style absolute path with forward slash', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'C:/Users/file.ts',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty path', () => {
    const result = ManifestEntrySchema.safeParse({
      path: '',
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('rejects path exceeding 4096 characters', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'a'.repeat(4097),
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(false);
  });

  it('accepts path exactly 4096 characters', () => {
    const result = ManifestEntrySchema.safeParse({
      path: 'a'.repeat(4096),
      scope: { kind: 'whole_file' },
    });
    expect(result.success).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// WritableManifest — v1 baseline
// ---------------------------------------------------------------------------

describe('WritableManifest', () => {
  const VALID_MANIFEST = {
    manifestSchemaVersion: 1 as const,
    projectId: 'widget-app',
    runId: 'run-abc-123',
    correlationId: 'corr-xyz-789',
    entries: [
      { path: 'src/util/format.ts', scope: { kind: 'whole_file' } },
    ],
  };

  it('accepts a valid manifest', () => {
    const result = WritableManifestSchema.safeParse(VALID_MANIFEST);
    expect(result.success).toBe(true);
  });

  it('rejects missing manifestSchemaVersion', () => {
    const { manifestSchemaVersion: _v, ...without } = VALID_MANIFEST;
    expect(WritableManifestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects missing runId', () => {
    const { runId: _r, ...without } = VALID_MANIFEST;
    expect(WritableManifestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects empty runId', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      runId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing correlationId', () => {
    const { correlationId: _c, ...without } = VALID_MANIFEST;
    expect(WritableManifestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects empty correlationId', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      correlationId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty projectId', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      projectId: '',
    });
    expect(result.success).toBe(false);
  });

  it('rejects projectId with whitespace', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      projectId: 'widget app',
    });
    expect(result.success).toBe(false);
  });

  it('rejects empty entries array', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      entries: [],
    });
    expect(result.success).toBe(false);
  });

  it('rejects missing projectId', () => {
    const { projectId: _p, ...without } = VALID_MANIFEST;
    expect(WritableManifestSchema.safeParse(without).success).toBe(false);
  });

  it('rejects entries array exceeding 1000 (H15)', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      entries: Array.from({ length: 1001 }, (_, i) => ({
        path: `src/file${i}.ts`,
        scope: { kind: 'whole_file' },
      })),
    });
    expect(result.success).toBe(false);
  });

  it('accepts entries array at exactly 1000 (H15)', () => {
    const result = WritableManifestSchema.safeParse({
      ...VALID_MANIFEST,
      entries: Array.from({ length: 1000 }, (_, i) => ({
        path: `src/file${i}.ts`,
        scope: { kind: 'whole_file' },
      })),
    });
    expect(result.success).toBe(true);
  });

  it('smoke test: zodToJsonSchema emits non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(WritableManifestSchema, 'WritableManifest');
    expect(jsonSchema).toBeDefined();
    const schemaStr = JSON.stringify(jsonSchema);
    expect(schemaStr.length).toBeGreaterThan(50);
    expect(jsonSchema).toHaveProperty('$schema');
  });
});

// ---------------------------------------------------------------------------
// SV1 — WritableManifest schema v2 additions
// ---------------------------------------------------------------------------

describe('SV1-1: v1 manifest still parses (backward compat)', () => {
  const V1_MANIFEST = {
    manifestSchemaVersion: 1 as const,
    projectId: 'acme-service',
    runId: 'run-v1-001',
    correlationId: 'corr-v1-abc',
    entries: [
      { path: 'src/api/handler.ts', scope: { kind: 'whole_file' } },
    ],
  };

  it('v1 manifest with manifestSchemaVersion: 1 and no new fields parses successfully', () => {
    const result = WritableManifestSchema.safeParse(V1_MANIFEST);
    expect(result.success).toBe(true);
  });

  it('v1 manifest has no signatureContracts on output', () => {
    const result = WritableManifestSchema.safeParse(V1_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signatureContracts).toBeUndefined();
    }
  });

  it('v1 manifest entries have no intent on output', () => {
    const result = WritableManifestSchema.safeParse(V1_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[0]!.intent).toBeUndefined();
    }
  });
});

describe('SV1-2: v2 manifest with intent: modify parses', () => {
  it('accepts manifestSchemaVersion: 2 with intent: modify', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'billing-svc',
      runId: 'run-v2-modify-001',
      correlationId: 'corr-v2-mod',
      entries: [
        {
          path: 'src/billing/charge.ts',
          scope: { kind: 'symbols', symbols: ['chargeCustomer'] },
          intent: 'modify',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parsed v2 manifest retains intent: modify on entry', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'billing-svc',
      runId: 'run-v2-modify-002',
      correlationId: 'corr-v2-mod2',
      entries: [
        {
          path: 'src/billing/charge.ts',
          scope: { kind: 'whole_file' },
          intent: 'modify',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[0]!.intent).toBe('modify');
    }
  });
});

describe('SV1-3: v2 manifest with intent: create parses', () => {
  it('accepts manifestSchemaVersion: 2 with intent: create', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'billing-svc',
      runId: 'run-v2-create-001',
      correlationId: 'corr-v2-create',
      entries: [
        {
          path: 'src/billing/invoice.ts',
          scope: { kind: 'symbols', symbols: ['generateInvoice'] },
          intent: 'create',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parsed v2 manifest retains intent: create on entry', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'billing-svc',
      runId: 'run-v2-create-002',
      correlationId: 'corr-v2-create2',
      entries: [
        {
          path: 'src/billing/invoice.ts',
          scope: { kind: 'whole_file' },
          intent: 'create',
        },
      ],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[0]!.intent).toBe('create');
    }
  });
});

describe('SV1-4: v2 manifest with invalid intent: delete rejects', () => {
  it('rejects intent: delete (not in ManifestIntent enum)', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'billing-svc',
      runId: 'run-v2-bad-intent',
      correlationId: 'corr-v2-bad',
      entries: [
        {
          path: 'src/billing/charge.ts',
          scope: { kind: 'whole_file' },
          intent: 'delete',
        },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejects intent: update (not in ManifestIntent enum)', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'billing-svc',
      runId: 'run-v2-bad-intent-2',
      correlationId: 'corr-v2-bad2',
      entries: [
        {
          path: 'src/billing/charge.ts',
          scope: { kind: 'whole_file' },
          intent: 'update',
        },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('SV1-5: v2 manifest with signatureContracts parses', () => {
  it('accepts signatureContracts array with 2 expectedParams and return type', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'auth-svc',
      runId: 'run-sigcontracts-001',
      correlationId: 'corr-sigcontracts',
      entries: [
        { path: 'src/auth/login.ts', scope: { kind: 'whole_file' } },
      ],
      signatureContracts: [
        {
          file: 'src/auth/login.ts',
          symbol: 'loginUser',
          expectedParams: [
            { name: 'username', type: 'string' },
            { name: 'password', type: 'string' },
          ],
          expectedReturn: 'Promise<AuthToken>',
        },
      ],
    });
    expect(result.success).toBe(true);
  });

  it('parsed signatureContracts data is preserved exactly', () => {
    const input = {
      manifestSchemaVersion: 2 as const,
      projectId: 'auth-svc',
      runId: 'run-sigcontracts-002',
      correlationId: 'corr-sigcontracts2',
      entries: [
        { path: 'src/auth/login.ts', scope: { kind: 'whole_file' as const } },
      ],
      signatureContracts: [
        {
          file: 'src/auth/login.ts',
          symbol: 'loginUser',
          expectedParams: [
            { name: 'username', type: 'string' },
            { name: 'password', type: 'string' },
          ],
          expectedReturn: 'Promise<AuthToken>',
        },
      ],
    };
    const result = WritableManifestSchema.safeParse(input);
    expect(result.success).toBe(true);
    if (result.success) {
      const sc = result.data.signatureContracts![0]!;
      expect(sc.file).toBe('src/auth/login.ts');
      expect(sc.symbol).toBe('loginUser');
      expect(sc.expectedParams).toHaveLength(2);
      expect(sc.expectedReturn).toBe('Promise<AuthToken>');
    }
  });
});

describe('SV1-6: SignatureContract with empty expectedParams parses', () => {
  it('accepts empty expectedParams array (function takes no arguments)', () => {
    const result = SignatureContractSchema.safeParse({
      file: 'src/util/noop.ts',
      symbol: 'noop',
      expectedParams: [],
      expectedReturn: 'void',
    });
    expect(result.success).toBe(true);
  });

  it('empty expectedParams in WritableManifest signatureContracts parses', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 2,
      projectId: 'util-pkg',
      runId: 'run-noparams-001',
      correlationId: 'corr-noparams',
      entries: [
        { path: 'src/util/noop.ts', scope: { kind: 'whole_file' } },
      ],
      signatureContracts: [
        {
          file: 'src/util/noop.ts',
          symbol: 'noop',
          expectedParams: [],
          expectedReturn: 'void',
        },
      ],
    });
    expect(result.success).toBe(true);
  });
});

describe('SV1-7: SignatureContract with optional: true param parses', () => {
  it('accepts param with optional: true', () => {
    const result = SignatureContractSchema.safeParse({
      file: 'src/logger.ts',
      symbol: 'log',
      expectedParams: [
        { name: 'message', type: 'string' },
        { name: 'context', type: 'Record<string, unknown>', optional: true },
      ],
      expectedReturn: 'void',
    });
    expect(result.success).toBe(true);
  });

  it('parsed SignatureParam retains optional: true', () => {
    const result = SignatureParamSchema.safeParse({
      name: 'options',
      type: 'RequestOptions',
      optional: true,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.optional).toBe(true);
    }
  });

  it('parsed SignatureParam with optional absent is undefined', () => {
    const result = SignatureParamSchema.safeParse({
      name: 'id',
      type: 'string',
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.optional).toBeUndefined();
    }
  });
});

describe('SV1-8: SignatureContract missing expectedReturn rejects', () => {
  it('rejects SignatureContract without expectedReturn', () => {
    const result = SignatureContractSchema.safeParse({
      file: 'src/api.ts',
      symbol: 'fetchData',
      expectedParams: [{ name: 'url', type: 'string' }],
      // expectedReturn is missing
    });
    expect(result.success).toBe(false);
  });

  it('rejects SignatureContract with empty expectedReturn', () => {
    const result = SignatureContractSchema.safeParse({
      file: 'src/api.ts',
      symbol: 'fetchData',
      expectedParams: [],
      expectedReturn: '',
    });
    expect(result.success).toBe(false);
  });
});

describe('SV1-9: v3 manifest rejects', () => {
  it('rejects manifestSchemaVersion: 3', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 3,
      projectId: 'future-svc',
      runId: 'run-v3-001',
      correlationId: 'corr-v3',
      entries: [
        { path: 'src/main.ts', scope: { kind: 'whole_file' } },
      ],
    });
    expect(result.success).toBe(false);
  });

  it('rejection error for v3 involves manifestSchemaVersion field', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 3,
      projectId: 'future-svc',
      runId: 'run-v3-002',
      correlationId: 'corr-v3-2',
      entries: [
        { path: 'src/main.ts', scope: { kind: 'whole_file' } },
      ],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorText = JSON.stringify(result.error.issues);
      // Error must mention manifestSchemaVersion (field path)
      expect(errorText.toLowerCase()).toContain('manifestschemaversion');
    }
  });
});

describe('SV1-10: Mixed v2 manifest — 3 entries, 2 signatureContracts', () => {
  const MIXED_MANIFEST = {
    manifestSchemaVersion: 2 as const,
    projectId: 'ecommerce-api',
    runId: 'run-mixed-001',
    correlationId: 'corr-mixed',
    entries: [
      {
        path: 'src/products/create.ts',
        scope: { kind: 'symbols' as const, symbols: ['createProduct'] },
        intent: 'create' as const,
      },
      {
        path: 'src/products/update.ts',
        scope: { kind: 'symbols' as const, symbols: ['updateProduct'] },
        intent: 'modify' as const,
      },
      {
        path: 'src/products/list.ts',
        scope: { kind: 'whole_file' as const },
        // no intent — omitted
      },
    ],
    signatureContracts: [
      {
        file: 'src/products/create.ts',
        symbol: 'createProduct',
        expectedParams: [
          { name: 'dto', type: 'CreateProductDto' },
        ],
        expectedReturn: 'Promise<Product>',
      },
      {
        file: 'src/products/update.ts',
        symbol: 'updateProduct',
        expectedParams: [
          { name: 'id', type: 'string' },
          { name: 'dto', type: 'UpdateProductDto' },
          { name: 'options', type: 'UpdateOptions', optional: true },
        ],
        expectedReturn: 'Promise<Product>',
      },
    ],
  };

  it('full parse succeeds for mixed v2 manifest', () => {
    const result = WritableManifestSchema.safeParse(MIXED_MANIFEST);
    expect(result.success).toBe(true);
  });

  it('entries with intent: create are preserved', () => {
    const result = WritableManifestSchema.safeParse(MIXED_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[0]!.intent).toBe('create');
    }
  });

  it('entries with intent: modify are preserved', () => {
    const result = WritableManifestSchema.safeParse(MIXED_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[1]!.intent).toBe('modify');
    }
  });

  it('entries without intent have undefined intent', () => {
    const result = WritableManifestSchema.safeParse(MIXED_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[2]!.intent).toBeUndefined();
    }
  });

  it('signatureContracts has exactly 2 entries', () => {
    const result = WritableManifestSchema.safeParse(MIXED_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signatureContracts).toHaveLength(2);
    }
  });

  it('second signatureContract has optional param preserved', () => {
    const result = WritableManifestSchema.safeParse(MIXED_MANIFEST);
    expect(result.success).toBe(true);
    if (result.success) {
      const sc = result.data.signatureContracts![1]!;
      expect(sc.expectedParams[2]!.optional).toBe(true);
    }
  });
});

describe('SV1-11: Backward compat — v1 fixture round-trip', () => {
  /**
   * This fixture is the canonical v1 manifest used across D1/D5/DR1 tests.
   * We parse it with the updated schema and assert:
   * - parse succeeds
   * - no field is stripped
   * - no field is added with a default
   * - output matches input exactly
   */
  const V1_FIXTURE = {
    manifestSchemaVersion: 1 as const,
    projectId: 'widget-app',
    runId: 'run-abc-123',
    correlationId: 'corr-xyz-789',
    entries: [
      { path: 'src/util/format.ts', scope: { kind: 'whole_file' as const } },
      {
        path: 'src/api/handler.ts',
        scope: { kind: 'symbols' as const, symbols: ['handleRequest', 'validateInput'] },
      },
    ],
  };

  it('v1 fixture parse succeeds', () => {
    const result = WritableManifestSchema.safeParse(V1_FIXTURE);
    expect(result.success).toBe(true);
  });

  it('v1 fixture: no fields are stripped', () => {
    const result = WritableManifestSchema.safeParse(V1_FIXTURE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.manifestSchemaVersion).toBe(1);
      expect(result.data.projectId).toBe('widget-app');
      expect(result.data.runId).toBe('run-abc-123');
      expect(result.data.correlationId).toBe('corr-xyz-789');
      expect(result.data.entries).toHaveLength(2);
    }
  });

  it('v1 fixture: no fields added with defaults (signatureContracts absent)', () => {
    const result = WritableManifestSchema.safeParse(V1_FIXTURE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.signatureContracts).toBeUndefined();
    }
  });

  it('v1 fixture: entry fields not modified — intent absent on both entries', () => {
    const result = WritableManifestSchema.safeParse(V1_FIXTURE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries[0]!.intent).toBeUndefined();
      expect(result.data.entries[1]!.intent).toBeUndefined();
    }
  });

  it('v1 fixture: output matches input exactly (deep equal, no extra keys)', () => {
    const result = WritableManifestSchema.safeParse(V1_FIXTURE);
    expect(result.success).toBe(true);
    if (result.success) {
      // Zod strips unknown keys by default; verify the known keys round-trip correctly
      expect(result.data).toMatchObject(V1_FIXTURE);
      // No extra keys beyond what v1 input contains
      const outputKeys = Object.keys(result.data).sort();
      // signatureContracts must NOT appear as a key (even as undefined is ok; we checked above)
      expect(outputKeys).not.toContain('signatureContracts');
    }
  });
});

// ---------------------------------------------------------------------------
// SV1 — zodToJsonSchema v2 smoke test
// ---------------------------------------------------------------------------

describe('zodToJsonSchema v2 smoke test', () => {
  it('zodToJsonSchema on v2 WritableManifestSchema produces non-empty JSON Schema', () => {
    const jsonSchema = zodToJsonSchema(WritableManifestSchema, 'WritableManifest');
    expect(jsonSchema).toBeDefined();
    const schemaStr = JSON.stringify(jsonSchema);
    expect(schemaStr.length).toBeGreaterThan(50);
    expect(jsonSchema).toHaveProperty('$schema');
  });
});

// ---------------------------------------------------------------------------
// ALIGN-1 — permitted_regions alias on WritableManifestSchema (H18)
// ---------------------------------------------------------------------------

describe('ALIGN-1: permitted_regions alias — entries-only input passes unchanged', () => {
  const BASE = {
    manifestSchemaVersion: 1 as const,
    projectId: 'align-1-proj',
    runId: 'run-align1-001',
    correlationId: 'corr-align1-001',
  };

  const ENTRY = { path: 'src/util/format.ts', scope: { kind: 'whole_file' as const } };

  it('entries-only input parses successfully', () => {
    const result = WritableManifestSchema.safeParse({ ...BASE, entries: [ENTRY] });
    expect(result.success).toBe(true);
  });

  it('entries-only input: parsed output contains entries', () => {
    const result = WritableManifestSchema.safeParse({ ...BASE, entries: [ENTRY] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0]!.path).toBe('src/util/format.ts');
    }
  });

  it('entries-only input: output has no permitted_regions key', () => {
    const result = WritableManifestSchema.safeParse({ ...BASE, entries: [ENTRY] });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.prototype.hasOwnProperty.call(result.data, 'permitted_regions')).toBe(false);
    }
  });
});

describe('ALIGN-1: permitted_regions alias — permitted_regions-only input normalizes to entries', () => {
  const BASE = {
    manifestSchemaVersion: 1 as const,
    projectId: 'align-1-proj',
    runId: 'run-align1-002',
    correlationId: 'corr-align1-002',
  };

  const ENTRY = { path: 'src/billing/charge.ts', scope: { kind: 'whole_file' as const } };

  it('permitted_regions-only input parses successfully', () => {
    const result = WritableManifestSchema.safeParse({
      ...BASE,
      permitted_regions: [ENTRY],
    });
    expect(result.success).toBe(true);
  });

  it('permitted_regions-only input: internal shape uses entries', () => {
    const result = WritableManifestSchema.safeParse({
      ...BASE,
      permitted_regions: [ENTRY],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0]!.path).toBe('src/billing/charge.ts');
    }
  });

  it('permitted_regions-only input: output has no permitted_regions key', () => {
    const result = WritableManifestSchema.safeParse({
      ...BASE,
      permitted_regions: [ENTRY],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(Object.prototype.hasOwnProperty.call(result.data, 'permitted_regions')).toBe(false);
    }
  });

  it('permitted_regions-only with multiple entries normalizes all', () => {
    const entries = [
      { path: 'src/a.ts', scope: { kind: 'whole_file' as const } },
      { path: 'src/b.ts', scope: { kind: 'symbols' as const, symbols: ['foo'] } },
    ];
    const result = WritableManifestSchema.safeParse({
      ...BASE,
      runId: 'run-align1-002b',
      correlationId: 'corr-align1-002b',
      permitted_regions: entries,
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries).toHaveLength(2);
      expect(result.data.entries[1]!.path).toBe('src/b.ts');
    }
  });
});

describe('ALIGN-1: permitted_regions alias — both identical → PASS', () => {
  const ENTRY = { path: 'src/shared.ts', scope: { kind: 'whole_file' as const } };

  it('entries and permitted_regions identical → parse succeeds', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-003',
      correlationId: 'corr-align1-003',
      entries: [ENTRY],
      permitted_regions: [ENTRY],
    });
    expect(result.success).toBe(true);
  });

  it('entries and permitted_regions identical → output entries are correct', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-003b',
      correlationId: 'corr-align1-003b',
      entries: [ENTRY],
      permitted_regions: [ENTRY],
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries).toHaveLength(1);
      expect(result.data.entries[0]!.path).toBe('src/shared.ts');
      expect(Object.prototype.hasOwnProperty.call(result.data, 'permitted_regions')).toBe(false);
    }
  });
});

describe('ALIGN-1: permitted_regions alias — both conflicting → ValidationError', () => {
  it('entries and permitted_regions with different paths → parse fails', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-004',
      correlationId: 'corr-align1-004',
      entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
      permitted_regions: [{ path: 'src/b.ts', scope: { kind: 'whole_file' } }],
    });
    expect(result.success).toBe(false);
  });

  it('conflict error message references permitted_regions and entries', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-004b',
      correlationId: 'corr-align1-004b',
      entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
      permitted_regions: [{ path: 'src/b.ts', scope: { kind: 'whole_file' } }],
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorText = JSON.stringify(result.error.issues);
      expect(errorText.toLowerCase()).toContain('permitted_regions');
    }
  });

  it('entries one item, permitted_regions two items → parse fails', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-004c',
      correlationId: 'corr-align1-004c',
      entries: [{ path: 'src/a.ts', scope: { kind: 'whole_file' } }],
      permitted_regions: [
        { path: 'src/a.ts', scope: { kind: 'whole_file' } },
        { path: 'src/c.ts', scope: { kind: 'whole_file' } },
      ],
    });
    expect(result.success).toBe(false);
  });
});

describe('ALIGN-1: permitted_regions alias — neither provided → ValidationError (unchanged)', () => {
  it('neither entries nor permitted_regions → parse fails', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-005',
      correlationId: 'corr-align1-005',
      // no entries, no permitted_regions
    });
    expect(result.success).toBe(false);
  });

  it('missing entries error mentions entries field', () => {
    const result = WritableManifestSchema.safeParse({
      manifestSchemaVersion: 1,
      projectId: 'align-1-proj',
      runId: 'run-align1-005b',
      correlationId: 'corr-align1-005b',
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const errorText = JSON.stringify(result.error.issues);
      expect(errorText.toLowerCase()).toContain('entries');
    }
  });
});

describe('ALIGN-1: permitted_regions alias — H19 backward-compat: v1 fixtures unaffected', () => {
  /**
   * Verify that existing v1 manifests (entries-only, no permitted_regions)
   * are completely unaffected by the preprocess layer.
   */
  const V1_FIXTURE = {
    manifestSchemaVersion: 1 as const,
    projectId: 'widget-app',
    runId: 'run-abc-123',
    correlationId: 'corr-xyz-789',
    entries: [
      { path: 'src/util/format.ts', scope: { kind: 'whole_file' as const } },
      {
        path: 'src/api/handler.ts',
        scope: { kind: 'symbols' as const, symbols: ['handleRequest', 'validateInput'] },
      },
    ],
  };

  it('v1 fixture round-trip unaffected by ALIGN-1 preprocess', () => {
    const result = WritableManifestSchema.safeParse(V1_FIXTURE);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.entries).toHaveLength(2);
      expect(result.data.entries[0]!.path).toBe('src/util/format.ts');
      expect(result.data.entries[1]!.path).toBe('src/api/handler.ts');
      expect(result.data.signatureContracts).toBeUndefined();
    }
  });
});
