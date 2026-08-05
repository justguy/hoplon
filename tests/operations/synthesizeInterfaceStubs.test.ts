/**
 * tests/operations/synthesizeInterfaceStubs.test.ts — t-028 interface-stub proof.
 *
 * Proof requirements:
 *   IS-1  Matched targets emit an authoritative `export declare function ...`
 *         line and contractCount=1; status = 'AUTHORITATIVE' when all match.
 *   IS-2  Unmatched targets emit `export declare const <symbol>: unknown;`
 *         with reason='no_signature_contract' and contractCount=0.
 *   IS-3  Mixed input → status 'PARTIAL'. Authoritative/placeholder counts
 *         track the split.
 *   IS-4  Overload-class input (two contracts, same (file, symbol)) emits
 *         one declaration line per contract in source order, joined by '\n',
 *         and contractCount reflects the bucket size.
 *   IS-5  Optional params render as `name?: type`; required render as `name: type`.
 *   IS-6  Stubs are sorted by (target.file, target.symbol). Same input →
 *         byte-identical output (H7).
 *   IS-7  Duplicate targets collapse to one stub per (file, symbol).
 *   IS-8  advisory: true is schema-pinned — callers see true on every result
 *         and the schema rejects a false override.
 *   IS-9  Emitted events are H13-compliant (start/end phases, content-free).
 *   IS-10 Invalid request (missing correlationId, empty targets) rejects with
 *         ValidationError.
 *   IS-11 Pre-aborted AbortSignal rejects before producing a result.
 *   IS-12 Invalid TypeScript type syntax in a SignatureContract rejects with
 *         ValidationError instead of silently emitting broken output.
 *   IS-13 Invalid target symbol names reject with ValidationError even on the
 *         placeholder path.
 */

import { describe, it, expect } from 'vitest';

import {
  synthesizeInterfaceStubs,
  type SynthesizeInterfaceStubsDeps,
} from '../../src/hoplon/operations/synthesizeInterfaceStubs.js';
import {
  SynthesizeInterfaceStubsResultSchema,
  type InterfaceStubTarget,
  type SynthesizeInterfaceStubsRequest,
} from '../../src/hoplon/contracts/interfaceStubs.js';
import type { SignatureContract } from '../../src/hoplon/contracts/manifest.js';
import { createMemoryEmitter } from '../../src/hoplon/adapters/emitter/memory.js';
import { assertEventIsContentFree } from '../../src/hoplon/adapters/emitter/assert.js';
import { ValidationError } from '../../src/hoplon/contracts/errors.js';

// ---------------------------------------------------------------------------
// Harness
// ---------------------------------------------------------------------------

function makeDeps(): {
  deps: SynthesizeInterfaceStubsDeps;
  emitter: ReturnType<typeof createMemoryEmitter>;
} {
  const emitter = createMemoryEmitter();
  return {
    deps: { emitter, engineId: 'engine-is-test' },
    emitter,
  };
}

function target(file: string, symbol: string): InterfaceStubTarget {
  return { file, symbol };
}

function contract(
  file: string,
  symbol: string,
  params: Array<{ name: string; type: string; optional?: boolean }>,
  ret: string,
): SignatureContract {
  return {
    file,
    symbol,
    expectedParams: params.map((p) => ({
      name: p.name,
      type: p.type,
      ...(p.optional === true ? { optional: true } : {}),
    })),
    expectedReturn: ret,
  };
}

function req(
  overrides: Partial<SynthesizeInterfaceStubsRequest> & {
    targets: InterfaceStubTarget[];
  },
): SynthesizeInterfaceStubsRequest {
  return {
    correlationId: 'corr-is-001',
    projectId: 'proj-is',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('synthesizeInterfaceStubs', () => {
  it('IS-1: matched target emits authoritative declaration', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [target('src/foo.ts', 'foo')],
        signatureContracts: [
          contract('src/foo.ts', 'foo', [{ name: 'x', type: 'number' }], 'string'),
        ],
      }),
    );

    expect(result.status).toBe('AUTHORITATIVE');
    expect(result.advisory).toBe(true);
    expect(result.authoritativeCount).toBe(1);
    expect(result.placeholderCount).toBe(0);
    expect(result.stubs).toHaveLength(1);
    const stub = result.stubs[0]!;
    expect(stub.quality).toBe('authoritative');
    expect(stub.reason).toBeNull();
    expect(stub.contractCount).toBe(1);
    expect(stub.declaration).toBe(
      'export declare function foo(x: number): string;',
    );
  });

  it('IS-2: unmatched target emits placeholder with closed reason', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [target('src/bar.ts', 'bar')],
        signatureContracts: [],
      }),
    );

    expect(result.status).toBe('PLACEHOLDER_ONLY');
    expect(result.authoritativeCount).toBe(0);
    expect(result.placeholderCount).toBe(1);
    const stub = result.stubs[0]!;
    expect(stub.quality).toBe('placeholder');
    expect(stub.reason).toBe('no_signature_contract');
    expect(stub.contractCount).toBe(0);
    expect(stub.declaration).toBe('export declare const bar: unknown;');
  });

  it('IS-3: mixed input yields PARTIAL status', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [target('src/a.ts', 'alpha'), target('src/b.ts', 'beta')],
        signatureContracts: [
          contract('src/a.ts', 'alpha', [], 'void'),
        ],
      }),
    );

    expect(result.status).toBe('PARTIAL');
    expect(result.authoritativeCount).toBe(1);
    expect(result.placeholderCount).toBe(1);
    const byFile = Object.fromEntries(
      result.stubs.map((s) => [s.target.file, s]),
    );
    expect(byFile['src/a.ts']!.quality).toBe('authoritative');
    expect(byFile['src/b.ts']!.quality).toBe('placeholder');
  });

  it('IS-4: overload-class input emits one line per contract in source order', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [target('src/over.ts', 'pick')],
        signatureContracts: [
          contract('src/over.ts', 'pick', [{ name: 'n', type: 'number' }], 'number'),
          contract('src/over.ts', 'pick', [{ name: 's', type: 'string' }], 'string'),
        ],
      }),
    );

    const stub = result.stubs[0]!;
    expect(stub.quality).toBe('authoritative');
    expect(stub.contractCount).toBe(2);
    expect(stub.declaration).toBe(
      [
        'export declare function pick(n: number): number;',
        'export declare function pick(s: string): string;',
      ].join('\n'),
    );
  });

  it('IS-5: optional params render with `?:` separator', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [target('src/opt.ts', 'maybe')],
        signatureContracts: [
          contract(
            'src/opt.ts',
            'maybe',
            [
              { name: 'required', type: 'number' },
              { name: 'hint', type: 'string', optional: true },
            ],
            'void',
          ),
        ],
      }),
    );

    expect(result.stubs[0]!.declaration).toBe(
      'export declare function maybe(required: number, hint?: string): void;',
    );
  });

  it('IS-6: stubs sorted by (file, symbol); same input → byte-identical output', async () => {
    const { deps: deps1 } = makeDeps();
    const { deps: deps2 } = makeDeps();
    const input = req({
      targets: [
        target('src/z.ts', 'zeta'),
        target('src/a.ts', 'beta'),
        target('src/a.ts', 'alpha'),
      ],
      signatureContracts: [
        contract('src/a.ts', 'alpha', [], 'void'),
        contract('src/a.ts', 'beta', [], 'void'),
        contract('src/z.ts', 'zeta', [], 'void'),
      ],
    });

    const r1 = await synthesizeInterfaceStubs(deps1, input);
    const r2 = await synthesizeInterfaceStubs(deps2, input);

    expect(r1.stubs.map((s) => [s.target.file, s.target.symbol])).toEqual([
      ['src/a.ts', 'alpha'],
      ['src/a.ts', 'beta'],
      ['src/z.ts', 'zeta'],
    ]);
    expect(JSON.stringify(r1)).toBe(JSON.stringify(r2));
  });

  it('IS-7: duplicate targets collapse to one stub per (file, symbol)', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [
          target('src/foo.ts', 'foo'),
          target('src/foo.ts', 'foo'),
          target('src/foo.ts', 'bar'),
        ],
        signatureContracts: [
          contract('src/foo.ts', 'foo', [], 'void'),
        ],
      }),
    );

    expect(result.stubs).toHaveLength(2);
    const keys = result.stubs.map((s) => `${s.target.file}|${s.target.symbol}`);
    expect(new Set(keys).size).toBe(2);
  });

  it('IS-8: advisory: true is a schema invariant on the output surface', async () => {
    const { deps } = makeDeps();
    const result = await synthesizeInterfaceStubs(
      deps,
      req({
        targets: [target('src/foo.ts', 'foo')],
        signatureContracts: [],
      }),
    );
    expect(result.advisory).toBe(true);

    const tampered = { ...result, advisory: false };
    const reparsed = SynthesizeInterfaceStubsResultSchema.safeParse(tampered);
    expect(reparsed.success).toBe(false);
  });

  it('IS-9: emitted events are H13-compliant', async () => {
    const { deps, emitter } = makeDeps();
    await synthesizeInterfaceStubs(
      deps,
      req({ targets: [target('src/foo.ts', 'foo')] }),
    );
    const events = emitter.getEvents();
    expect(events).toHaveLength(2);
    expect(events.map((e) => e.phase)).toEqual(['start', 'end']);
    for (const ev of events) {
      expect(ev.op).toBe('synthesizeInterfaceStubs');
      assertEventIsContentFree(ev);
    }
  });

  it('IS-10: invalid request rejects with ValidationError', async () => {
    const { deps } = makeDeps();
    await expect(
      synthesizeInterfaceStubs(
        deps,
        // empty targets — schema requires at least one
        { correlationId: 'corr-is-bad', targets: [] } as unknown as SynthesizeInterfaceStubsRequest,
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('IS-11: pre-aborted signal rejects before producing a result', async () => {
    const { deps } = makeDeps();
    const ctrl = new AbortController();
    ctrl.abort();
    await expect(
      synthesizeInterfaceStubs(
        deps,
        req({ targets: [target('src/foo.ts', 'foo')] }),
        ctrl.signal,
      ),
    ).rejects.toThrow();
  });

  it('IS-12: invalid TypeScript type syntax rejects with ValidationError', async () => {
    const { deps } = makeDeps();
    await expect(
      synthesizeInterfaceStubs(
        deps,
        req({
          targets: [target('src/foo.ts', 'foo')],
          signatureContracts: [
            contract('src/foo.ts', 'foo', [{ name: 'x', type: 'number[' }], 'void'),
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });

  it('IS-13: invalid target symbol rejects on the placeholder path', async () => {
    const { deps } = makeDeps();
    await expect(
      synthesizeInterfaceStubs(
        deps,
        req({
          targets: [target('src/foo.ts', 'not-valid-symbol')],
          signatureContracts: [],
        }),
      ),
    ).rejects.toBeInstanceOf(ValidationError);
  });
});
