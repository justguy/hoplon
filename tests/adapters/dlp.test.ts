/**
 * tests/adapters/dlp.test.ts — t-026 DlpAdapter unit coverage.
 *
 * Targets the adapter surface directly, independent of createSnapshot:
 *   - `createNoopDlpAdapter` always returns empty findings.
 *   - `createMockPatternDlpAdapter` redacts matches, respects classification,
 *     line numbering, optional confidence, and optional path filtering.
 *   - Findings round-trip cleanly through `DlpFindingSchema`.
 */

import { describe, it, expect } from 'vitest';

import {
  createNoopDlpAdapter,
  createMockPatternDlpAdapter,
} from '../../src/hoplon/adapters/dlp.js';
import { DlpFindingSchema } from '../../src/hoplon/contracts/dlp.js';

const enc = (s: string) => new TextEncoder().encode(s);

describe('createNoopDlpAdapter', () => {
  it('returns an empty finding array', async () => {
    const adapter = createNoopDlpAdapter();
    const out = await adapter.scan({ path: 'a.ts', content: enc('x = 1') });
    expect(out).toEqual([]);
  });
});

describe('createMockPatternDlpAdapter', () => {
  it('emits a redacted finding per matched line', async () => {
    const adapter = createMockPatternDlpAdapter({
      rules: [
        {
          ruleId: 'ssn-us',
          classification: 'pii',
          pattern: /\b\d{3}-\d{2}-\d{4}\b/,
          confidence: 0.8,
        },
      ],
    });
    const content = enc(
      [
        'const a = 1;',
        'const ssn = "123-45-6789";',
        'const other = "nothing";',
      ].join('\n'),
    );
    const out = await adapter.scan({ path: 'src/a.ts', content });
    expect(out).toHaveLength(1);
    const only = out[0]!;
    expect(only.ruleId).toBe('ssn-us');
    expect(only.classification).toBe('pii');
    expect(only.confidence).toBe(0.8);
    expect(only.lineNumber).toBe(2);
    expect(only.redactedSnippet).not.toContain('123-45-6789');
    expect(only.redactedSnippet).toContain('[REDACTED_PII]');
    // Round-trips through the schema without parse errors.
    expect(() => DlpFindingSchema.parse(only)).not.toThrow();
  });

  it('omits confidence when the rule does not supply one', async () => {
    const adapter = createMockPatternDlpAdapter({
      rules: [
        {
          ruleId: 'cc-like',
          classification: 'financial',
          pattern: /\b4\d{15}\b/,
        },
      ],
    });
    const out = await adapter.scan({
      path: 'a.ts',
      content: enc('const x = "4111111111111111";'),
    });
    expect(out).toHaveLength(1);
    expect(out[0]!.confidence).toBeUndefined();
  });

  it('respects onlyPaths allow-list', async () => {
    const adapter = createMockPatternDlpAdapter({
      rules: [
        {
          ruleId: 'any',
          classification: 'other',
          pattern: /secret/,
        },
      ],
      onlyPaths: ['included.ts'],
    });
    const excluded = await adapter.scan({
      path: 'excluded.ts',
      content: enc('secret'),
    });
    const included = await adapter.scan({
      path: 'included.ts',
      content: enc('secret'),
    });
    expect(excluded).toEqual([]);
    expect(included).toHaveLength(1);
  });
});
