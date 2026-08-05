/**
 * tests/transport/http.review.test.ts — packaged HTTP review route proof (t-072).
 *
 * Exercises `POST /session/review` on the shipped Fastify server via
 * `fastify.inject()`. Uses a mock engine + memfs adapter + a fake
 * CodeIntelligenceAdapter so the test is hermetic and focused on
 * contract / transport wiring; real tree-sitter coverage lives in the
 * selfhost proof.
 */

import { describe, it, expect } from 'vitest';

import { createHoplonHttpServer } from '../../src/hoplon/transport/http/server.js';
import { createSessionRegistry } from '../../src/hoplon/session/registry.js';
import { createMemFsAdapter } from '../../src/hoplon/adapters/fs/memfs.js';
import type {
  CodeIntelligenceAdapter,
  Symbol as CiSymbol,
  SyntaxTree,
} from '../../src/hoplon/adapters/codeIntelligence.js';
import { SessionReviewPayloadSchema } from '../../src/hoplon/contracts/reviewPayload.js';
import { makeMockEngine, MANIFEST } from '../session/helpers.js';

function fakeCi(symbolsFor: (text: string) => CiSymbol[]): CodeIntelligenceAdapter {
  return {
    async parse(_file, bytes) {
      return {
        rootNode: { kind: 'program', children: [new TextDecoder().decode(bytes)] },
      } as unknown as SyntaxTree;
    },
    getTopLevelSymbols(tree) {
      const text = (tree as unknown as { rootNode: { children: unknown[] } }).rootNode
        .children[0] as string;
      return symbolsFor(text);
    },
  };
}

function rangeOfBlock(text: string, start: string, end: string): [number, number] {
  const idx = text.indexOf(start);
  const close = text.indexOf(end, idx);
  return [
    Buffer.byteLength(text.slice(0, idx), 'utf8'),
    Buffer.byteLength(text.slice(0, close + end.length), 'utf8'),
  ];
}

describe('HTTP /session/review (t-072 + t-077)', () => {
  it('returns a bounded review payload with canonical dependencyImpact over an applyEdits session', async () => {
    const fs = createMemFsAdapter();
    const before = 'export function alpha() {\n  return 1;\n}\n';
    await fs.write('src/foo.ts', new TextEncoder().encode(before));
    const codeIntelligence = fakeCi((text) => [
      {
        name: 'alpha',
        kind: 'function_declaration',
        byteRange: rangeOfBlock(text, 'export function alpha() {', '}'),
      },
    ]);
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine, fs, codeIntelligence });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });

    const manifest = {
      ...MANIFEST,
      entries: [{ path: 'src/foo.ts', scope: { kind: 'whole_file' as const } }],
    };

    try {
      const startRes = await server.inject({
        method: 'POST',
        url: '/session/start',
        payload: { manifest },
      });
      expect(startRes.statusCode).toBe(200);
      const sessionId = JSON.parse(startRes.body).session.sessionId as string;

      await server.inject({ method: 'POST', url: '/session/preflight', payload: { sessionId } });
      await server.inject({ method: 'POST', url: '/session/createSnapshot', payload: { sessionId } });
      await server.inject({
        method: 'POST',
        url: '/session/applyEdits',
        payload: {
          sessionId,
          proposedChanges: [
            {
              file: 'src/foo.ts',
              content: 'export function alpha() {\n  return 7;\n}\n',
            },
          ],
        },
      });

      const reviewRes = await server.inject({
        method: 'POST',
        url: '/session/review',
        payload: { sessionId, includeDependencyImpact: true },
      });
      expect(reviewRes.statusCode).toBe(200);
      const body = JSON.parse(reviewRes.body) as {
        data: { review: unknown };
      };
      const parsed = SessionReviewPayloadSchema.safeParse(body.data.review);
      expect(parsed.success).toBe(true);
      if (parsed.success) {
        expect(parsed.data.changedFiles).toEqual(['src/foo.ts']);
        expect(parsed.data.files[0]?.boundaries[0]?.symbol).toBe('alpha');
        expect(parsed.data.files[0]?.boundaries[0]?.unifiedDiff).toContain('+  return 7;');
        expect(parsed.data.changeKindCounts).toEqual({
          full_file: 1,
          patch: 0,
          structural: 0,
        });
        // t-077 — dependencyImpact is the canonical impact sidecar; the mock
        // engine defaults analyzeBlastRadius to UNAVAILABLE, so the pane
        // degrades honestly rather than fabricating reference counts.
        const di = parsed.data.impact.dependencyImpact;
        expect(di.advisory).toBe(true);
        expect(di.subjects[0]).toMatchObject({
          kind: 'symbol',
          path: 'src/foo.ts',
          symbolName: 'alpha',
          origin: 'review_boundary',
        });
        expect(['AVAILABLE', 'DEGRADED', 'UNAVAILABLE']).toContain(di.status);
      }
    } finally {
      await server.close();
      registry.dispose();
    }
  });

  it('returns 404 SessionTransportError envelope when the sessionId is unknown', async () => {
    const fs = createMemFsAdapter();
    const engine = makeMockEngine();
    const registry = createSessionRegistry({ engine, fs });
    const server = await createHoplonHttpServer({ engine, sessionRegistry: registry });
    try {
      const res = await server.inject({
        method: 'POST',
        url: '/session/review',
        payload: { sessionId: 'no-such-session' },
      });
      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body) as {
        error: { class: string; kind: string };
      };
      expect(body.error.class).toBe('SessionTransportError');
      expect(body.error.kind).toBe('session_not_found');
    } finally {
      await server.close();
      registry.dispose();
    }
  });
});
