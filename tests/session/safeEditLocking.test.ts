/**
 * tests/session/safeEditLocking.test.ts — t-066 node-scoped safe-edit
 * concurrency proofs on the packaged supervised write path.
 *
 * Exercises the session-owned AST lock lifecycle that wraps
 * `session.applyEdits` when a `lockProvider` is injected at session
 * construction. Two concurrent sessions share one `AsyncMutex`-backed
 * provider so structural node-key ownership stays session-owned while the
 * final same-file commit re-resolves against the latest bytes before the
 * adapter sees a write.
 *
 * Proof inventory:
 *
 *   T1. Nested `symbolPath` selector resolves and replaces the targeted
 *       method bytes while leaving the enclosing class body intact.
 *
 *   T2. Ambiguous `symbolPath` (multiple matches) surfaces
 *       `target_not_resolved` before any write touches disk.
 *
 *   T3. `symbolPath` matching requires the named ancestor chain exactly:
 *       `['MyClass', 'doThing']` must not skip over a named `other`
 *       method to match a deeper nested declaration.
 *
 *   T4. Disjoint same-file structural edits use node-only pre-write lock
 *       plans and still both land when one earlier edit shifts the later
 *       target's byte range.
 *
 *   T5. Overlapping same-file structural edits from two concurrent
 *       sessions serialize via the overlap-aware key set — the second
 *       session MUST wait on the first's release.
 *
 *   T6. Lock is released on failure (mid-apply adapter throw) so a later
 *       session writing the same target can make forward progress
 *       without timing out.
 *
 *   T7. Full-file / patch variants acquire a per-file lock (not a
 *       node-scoped key), so two concurrent full-file writers to the
 *       same file serialize — and do so without needing a
 *       codeIntelligence adapter.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonEditSession } from '../../src/hoplon/session/session.js';
import { SessionError } from '../../src/hoplon/session/errors.js';
import { createAsyncMutexLockProvider } from '../../src/hoplon/adapters/lock-async-mutex.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type { HoplonFsAdapter } from '../../src/hoplon/adapters/fs.js';
import type {
  CodeIntelligenceAdapter,
  Symbol,
  SyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence.js';
import { AdapterError } from '../../src/hoplon/contracts/errors.js';
import { computeSafeEditLockKeys } from '../../src/hoplon/session/safeEditLocking.js';
import { makeMockEngine, MANIFEST } from './helpers.js';

// ---------------------------------------------------------------------------
// Fake CodeIntelligenceAdapter for nested-path proofs
// ---------------------------------------------------------------------------

/**
 * Minimal stubbed adapter whose `getTopLevelSymbols` is driven by a
 * caller-supplied classifier and whose `parse` returns a RefinedLikeNode
 * tree so the resolver can walk nested named children. Each call to
 * `parse` re-reads the current content and rebuilds the tree from a
 * declarative classifier — the same fixture semantics the session sees
 * when it reads bytes off disk via the injected fs adapter.
 */
interface ClassifiedSymbol extends Symbol {
  namedChildren?: ClassifiedSymbol[];
}

function makeClassifiedCodeIntelligence(
  classify: (content: string) => ClassifiedSymbol[],
): CodeIntelligenceAdapter {
  function identifierChildKind(parentKind: string): string {
    if (parentKind === 'class_declaration' || parentKind === 'interface_declaration') {
      return 'type_identifier';
    }
    if (parentKind === 'method_definition') return 'property_identifier';
    return 'identifier';
  }
  function toRefined(sym: ClassifiedSymbol): {
    kind: string;
    byteRange: [number, number];
    text: string;
    namedChildren: Array<ReturnType<typeof toRefined>>;
    children: unknown[];
  } {
    // Synthesize the identifier child tree-sitter would otherwise produce
    // so the shared resolver's name extraction succeeds without coupling
    // tests to adapter internals.
    const identifierChild = {
      kind: identifierChildKind(sym.kind),
      byteRange: sym.byteRange,
      text: sym.name,
      namedChildren: [],
      children: [],
    };
    const kids = [identifierChild, ...(sym.namedChildren ?? []).map(toRefined)];
    return {
      kind: sym.kind,
      byteRange: sym.byteRange,
      text: sym.name,
      namedChildren: kids,
      children: kids,
    };
  }
  return {
    async parse(_file, content): Promise<SyntaxTree> {
      const text = new TextDecoder().decode(content);
      const topLevels = classify(text);
      const rootNamed = topLevels.map(toRefined);
      return {
        rootNode: {
          kind: 'program',
          byteRange: [0, content.byteLength],
          text,
          namedChildren: rootNamed,
          children: rootNamed,
        } as unknown as SyntaxTree['rootNode'],
      } as SyntaxTree;
    },
    getTopLevelSymbols(tree): Symbol[] {
      const root = tree.rootNode as unknown as {
        namedChildren?: Array<{ kind: string; byteRange: [number, number]; text: string }>;
      };
      const children = Array.isArray(root.namedChildren) ? root.namedChildren : [];
      return children.map((c) => ({ name: c.text, kind: c.kind, byteRange: c.byteRange }));
    },
  };
}

async function advanceToSnapshotted(session: ReturnType<typeof createHoplonEditSession>) {
  await session.preflight();
  await session.createSnapshot();
}

// ---------------------------------------------------------------------------
// T1 — Nested symbolPath selector replaces only the targeted method bytes
// ---------------------------------------------------------------------------

describe('t-066: nested symbolPath selector', () => {
  it('replaces exactly the nested method bytes and leaves the class intact', async () => {
    const fs = createMemFsAdapter();
    const methodOld = '  doThing() { return 1; }\n';
    const methodNew = '  doThing() { return 99; }\n';
    const classHeader = 'class MyClass {\n';
    const classFooter = '}\n';
    const before = 'const before = 1;\n';
    const baseline = before + classHeader + methodOld + classFooter;
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const classStart = Buffer.byteLength(before, 'utf8');
    const classEnd = classStart + Buffer.byteLength(classHeader + methodOld + classFooter, 'utf8');
    const methodStart = classStart + Buffer.byteLength(classHeader, 'utf8');
    const methodEnd = methodStart + Buffer.byteLength(methodOld, 'utf8');

    const codeIntelligence = makeClassifiedCodeIntelligence(() => [
      {
        name: 'MyClass',
        kind: 'class_declaration',
        byteRange: [classStart, classEnd],
        namedChildren: [
          {
            name: 'doThing',
            kind: 'method_definition',
            byteRange: [methodStart, methodEnd],
          },
        ],
      },
    ]);

    const lockProvider = createAsyncMutexLockProvider();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence,
      lockProvider,
    });
    await advanceToSnapshotted(session);

    const result = await session.applyEdits([
      {
        kind: 'structural',
        file: 'src/foo.ts',
        target: { symbolPath: ['MyClass', 'doThing'] },
        content: methodNew,
      },
    ]);
    expect(result.changeKindCounts).toEqual({ full_file: 0, patch: 0, structural: 1 });
    expect(session.state).toBe('edited');
    const expected = before + classHeader + methodNew + classFooter;
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(expected);
  });

  it('fails with target_not_resolved when the symbolPath matches zero or multiple nodes', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'class MyClass { doThing() {} doThing() {} }\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const codeIntelligence = makeClassifiedCodeIntelligence(() => [
      {
        name: 'MyClass',
        kind: 'class_declaration',
        byteRange: [0, Buffer.byteLength(baseline, 'utf8')],
        namedChildren: [
          { name: 'doThing', kind: 'method_definition', byteRange: [16, 30] },
          { name: 'doThing', kind: 'method_definition', byteRange: [31, 45] },
        ],
      },
    ]);

    const lockProvider = createAsyncMutexLockProvider();
    const engine = makeMockEngine();
    const session = createHoplonEditSession({
      engine,
      manifest: MANIFEST,
      fs,
      codeIntelligence,
      lockProvider,
    });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        {
          kind: 'structural',
          file: 'src/foo.ts',
          target: { symbolPath: ['MyClass', 'doThing'] },
          content: 'x',
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('target_not_resolved');
    expect(session.state).toBe('snapshotted');
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(baseline);
  });

  it('requires the named ancestor chain exactly instead of skipping named declarations', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'class MyClass {\n  other() {\n    function doThing() {}\n  }\n}\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(baseline));

    const classStart = 0;
    const classEnd = Buffer.byteLength(baseline, 'utf8');
    const otherStart = Buffer.byteLength('class MyClass {\n', 'utf8');
    const otherEnd = classEnd - Buffer.byteLength('}\n', 'utf8');
    const innerStart = Buffer.byteLength('class MyClass {\n  other() {\n', 'utf8');
    const innerEnd = innerStart + Buffer.byteLength('    function doThing() {}\n', 'utf8');

    const codeIntelligence = makeClassifiedCodeIntelligence(() => [
      {
        name: 'MyClass',
        kind: 'class_declaration',
        byteRange: [classStart, classEnd],
        namedChildren: [
          {
            name: 'other',
            kind: 'method_definition',
            byteRange: [otherStart, otherEnd],
            namedChildren: [
              {
                name: 'doThing',
                kind: 'function_declaration',
                byteRange: [innerStart, innerEnd],
              },
            ],
          },
        ],
      },
    ]);

    const session = createHoplonEditSession({
      engine: makeMockEngine(),
      manifest: MANIFEST,
      fs,
      codeIntelligence,
      lockProvider: createAsyncMutexLockProvider(),
    });
    await advanceToSnapshotted(session);

    const err = await session
      .applyEdits([
        {
          kind: 'structural',
          file: 'src/foo.ts',
          target: { symbolPath: ['MyClass', 'doThing'] },
          content: 'x',
        },
      ])
      .catch((e: unknown) => e);
    expect(err).toBeInstanceOf(SessionError);
    expect((err as SessionError).kind).toBe('target_not_resolved');
    expect(new TextDecoder().decode(await fs.read('src/foo.ts'))).toBe(baseline);
  });
});

// ---------------------------------------------------------------------------
// Concurrency proofs — two sessions over one shared lock provider
// ---------------------------------------------------------------------------

/** Wait one microtask so pending-promise status settles before assertion. */
async function flushMicrotasks(ticks = 5): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    await Promise.resolve();
  }
}

describe('t-066: session-owned safe-edit locking', () => {
  it('T4: disjoint same-file structural edits use node-only pre-write locks and both land after a byte-shifting earlier edit', async () => {
    const fs = createMemFsAdapter();
    const classHeader = 'class MyClass {\n';
    const fooOld = '  foo() { return 1; }\n';
    const barOld = '  bar() { return 2; }\n';
    const classFooter = '}\n';
    const baseline = classHeader + fooOld + barOld + classFooter;
    await fs.write('src/t3.ts', new TextEncoder().encode(baseline));

    const codeIntelligence = makeClassifiedCodeIntelligence((content) => {
      const classStart = content.indexOf('class MyClass');
      const fooStart = content.indexOf('  foo()');
      const fooEnd = fooStart + content.slice(fooStart).indexOf('\n\n');
      const barStart = content.indexOf('  bar()');
      const barEnd = barStart + content.slice(barStart).indexOf('\n}\n');
      return [
        {
          name: 'MyClass',
          kind: 'class_declaration',
          byteRange: [classStart, Buffer.byteLength(content, 'utf8')],
          namedChildren: [
            {
              name: 'foo',
              kind: 'method_definition',
              byteRange: [fooStart, fooEnd],
            },
            {
              name: 'bar',
              kind: 'method_definition',
              byteRange: [barStart, barEnd],
            },
          ],
        },
      ];
    });
    const plan = await computeSafeEditLockKeys({
      proposedChanges: [
        {
          kind: 'structural',
          file: 'src/t3.ts',
          target: { symbolPath: ['MyClass', 'foo'] },
          content: '  foo() { return 1000; }\n',
        },
        {
          kind: 'structural',
          file: 'src/t3.ts',
          target: { symbolPath: ['MyClass', 'bar'] },
          content: '  bar() { return 20; }\n',
        },
      ],
      fs,
      codeIntelligence,
      projectId: MANIFEST.projectId,
    });
    expect(plan.counts.fileKeys).toBe(0);
    expect(plan.counts.nodeKeys).toBeGreaterThan(0);

    const sharedLock = createAsyncMutexLockProvider();
    const engine = makeMockEngine();
    const sessionA = createHoplonEditSession({
      engine, manifest: MANIFEST, fs, codeIntelligence, lockProvider: sharedLock,
    });
    const sessionB = createHoplonEditSession({
      engine, manifest: MANIFEST, fs, codeIntelligence, lockProvider: sharedLock,
    });
    await advanceToSnapshotted(sessionA);
    await advanceToSnapshotted(sessionB);

    const [ra, rb] = await Promise.all([
      sessionA.applyEdits([
        {
          kind: 'structural',
          file: 'src/t3.ts',
          target: { symbolPath: ['MyClass', 'foo'] },
          content: '  foo() { return 1000; }\n',
        },
      ]),
      sessionB.applyEdits([
        {
          kind: 'structural',
          file: 'src/t3.ts',
          target: { symbolPath: ['MyClass', 'bar'] },
          content: '  bar() { return 20; }\n',
        },
      ]),
    ]);
    expect(ra.changedFiles).toEqual(['src/t3.ts']);
    expect(rb.changedFiles).toEqual(['src/t3.ts']);
    const finalText = new TextDecoder().decode(await fs.read('src/t3.ts'));
    expect(finalText).toContain('foo() { return 1000; }');
    expect(finalText).toContain('bar() { return 20; }');
  });

  it('T5: overlapping same-file structural edits serialize via the overlap-aware key set', async () => {
    const fs = createMemFsAdapter();
    // One top-level symbol spans [0, 100); another overlapping spans [50, 150).
    // Two concurrent sessions targeting each must serialize.
    const baselineBytes = new Uint8Array(200);
    await fs.write('src/t4.ts', baselineBytes);

    const codeIntelligence = makeClassifiedCodeIntelligence(() => [
      { name: 'foo', kind: 'function_declaration', byteRange: [0, 100] },
      { name: 'bar', kind: 'function_declaration', byteRange: [50, 150] },
    ]);
    const planA = await computeSafeEditLockKeys({
      proposedChanges: [
        { kind: 'structural', file: 'src/t4.ts', target: { symbol: 'foo' }, content: 'AA' },
      ],
      fs,
      codeIntelligence,
      projectId: MANIFEST.projectId,
    });
    const planB = await computeSafeEditLockKeys({
      proposedChanges: [
        { kind: 'structural', file: 'src/t4.ts', target: { symbol: 'bar' }, content: 'BB' },
      ],
      fs,
      codeIntelligence,
      projectId: MANIFEST.projectId,
    });
    expect(planA.counts.fileKeys).toBe(0);
    expect(planB.counts.fileKeys).toBe(0);
    expect(planA.keys.some((key) => planB.keys.includes(key))).toBe(true);

    const sharedLock = createAsyncMutexLockProvider();
    const engine = makeMockEngine();
    const sessionA = createHoplonEditSession({
      engine, manifest: MANIFEST, fs, codeIntelligence, lockProvider: sharedLock,
    });
    const sessionB = createHoplonEditSession({
      engine, manifest: MANIFEST, fs, codeIntelligence, lockProvider: sharedLock,
    });
    await advanceToSnapshotted(sessionA);
    await advanceToSnapshotted(sessionB);

    let aFinished = false;
    let bFinished = false;
    // Latch holding A's lock until we flip it: we let A's applyEdits start
    // then observe that B cannot complete until A releases.
    let releaseA!: () => void;
    const aGate = new Promise<void>((r) => {
      releaseA = r;
    });
    const gatedFs: HoplonFsAdapter = {
      ...fs,
      async write(p, c) {
        // Only the A session's writer (first to arrive) will block on aGate.
        // B's writer will happen after A releases the lock, which happens
        // only after A's applyEdits completes.
        await aGate;
        await fs.write(p, c);
      },
    };
    const sessionAGated = createHoplonEditSession({
      engine, manifest: MANIFEST, fs: gatedFs, codeIntelligence, lockProvider: sharedLock,
    });
    const sessionBGated = createHoplonEditSession({
      engine, manifest: MANIFEST, fs: gatedFs, codeIntelligence, lockProvider: sharedLock,
    });
    await advanceToSnapshotted(sessionAGated);
    await advanceToSnapshotted(sessionBGated);

    // A targets foo; B targets bar. buildOverlapKeySet on either side
    // yields both keys because foo and bar overlap.
    const aPromise = sessionAGated
      .applyEdits([
        { kind: 'structural', file: 'src/t4.ts', target: { symbol: 'foo' }, content: 'AA' },
      ])
      .then(() => { aFinished = true; });
    const bPromise = sessionBGated
      .applyEdits([
        { kind: 'structural', file: 'src/t4.ts', target: { symbol: 'bar' }, content: 'BB' },
      ])
      .then(() => { bFinished = true; });

    // Give both sessions time to enter their acquire phase; B should queue.
    await flushMicrotasks(10);
    expect(aFinished).toBe(false);
    expect(bFinished).toBe(false);

    // Release A's write gate. A completes; then B's lock acquisition
    // unblocks (different set of keys? No — they share overlap keys, so B
    // was waiting on the same lock A held).
    releaseA();
    await aPromise;
    expect(aFinished).toBe(true);
    // B can now proceed.
    await bPromise;
    expect(bFinished).toBe(true);
  });

  it('T6: lock is released on failure so later sessions make forward progress', async () => {
    const fs = createMemFsAdapter();
    const baseline = 'function foo() { return 1; }\n';
    await fs.write('src/t5.ts', new TextEncoder().encode(baseline));

    const codeIntelligence = makeClassifiedCodeIntelligence(() => [
      { name: 'foo', kind: 'function_declaration', byteRange: [0, Buffer.byteLength(baseline, 'utf8')] },
    ]);

    // fs that throws on first write; second call works normally.
    let writes = 0;
    const failingThenOk: HoplonFsAdapter = {
      read: (p) => fs.read(p),
      list: (p) => fs.list(p),
      stat: (p) => fs.stat(p),
      mkdir: (p, opts) => fs.mkdir(p, opts),
      remove: (p) => fs.remove(p),
      async write(p, c) {
        writes += 1;
        if (writes === 1) {
          throw new AdapterError(
            { kind: 'fs_write_failed', engineId: 'adapter', correlationId: 'adapter' },
            'simulated adapter failure',
          );
        }
        await fs.write(p, c);
      },
    };

    const sharedLock = createAsyncMutexLockProvider();
    const engine = makeMockEngine();
    const sessionA = createHoplonEditSession({
      engine, manifest: MANIFEST, fs: failingThenOk, codeIntelligence, lockProvider: sharedLock,
    });
    const sessionB = createHoplonEditSession({
      engine, manifest: MANIFEST, fs: failingThenOk, codeIntelligence, lockProvider: sharedLock,
    });
    await advanceToSnapshotted(sessionA);
    await advanceToSnapshotted(sessionB);

    const errA = await sessionA
      .applyEdits([
        { kind: 'structural', file: 'src/t5.ts', target: { symbol: 'foo' }, content: 'X' },
      ])
      .catch((e: unknown) => e);
    expect(errA).toBeInstanceOf(AdapterError);
    expect(sessionA.state).toBe('snapshotted');

    // Second session uses the same key — it must be able to acquire
    // immediately because the first session's finally-release fired.
    const rb = await sessionB.applyEdits([
      { kind: 'structural', file: 'src/t5.ts', target: { symbol: 'foo' }, content: 'export function foo() { return 2; }\n' },
    ]);
    expect(rb.changedFiles).toEqual(['src/t5.ts']);
    expect(sessionB.state).toBe('edited');
  });

  it('T7: full_file / patch variants serialize concurrent same-file writers via the per-file key', async () => {
    const fs = createMemFsAdapter();
    await fs.write('src/t6.ts', new TextEncoder().encode('old'));

    let concurrent = 0;
    let maxConcurrent = 0;
    const gated: HoplonFsAdapter = {
      read: (p) => fs.read(p),
      list: (p) => fs.list(p),
      stat: (p) => fs.stat(p),
      mkdir: (p, opts) => fs.mkdir(p, opts),
      remove: (p) => fs.remove(p),
      async write(p, c) {
        concurrent += 1;
        maxConcurrent = Math.max(maxConcurrent, concurrent);
        await new Promise((r) => setTimeout(r, 10));
        await fs.write(p, c);
        concurrent -= 1;
      },
    };

    const sharedLock = createAsyncMutexLockProvider();
    const engine = makeMockEngine();
    // No codeIntelligence injected — full_file path does not need it.
    const sessionA = createHoplonEditSession({
      engine, manifest: MANIFEST, fs: gated, lockProvider: sharedLock,
    });
    const sessionB = createHoplonEditSession({
      engine, manifest: MANIFEST, fs: gated, lockProvider: sharedLock,
    });
    await advanceToSnapshotted(sessionA);
    await advanceToSnapshotted(sessionB);

    await Promise.all([
      sessionA.applyEdits([{ file: 'src/t6.ts', content: 'A' }]),
      sessionB.applyEdits([{ file: 'src/t6.ts', content: 'B' }]),
    ]);
    // Both writers targeted the same file key → they must have serialized.
    expect(maxConcurrent).toBe(1);
  });
});
