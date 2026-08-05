import { describe, expect, it } from 'vitest';

import { buildGeneratedTestAffinityManifest } from '../../src/hoplon/operations/testAffinityExtractor.js';

describe('buildGeneratedTestAffinityManifest', () => {
  it('extracts deterministic route and MCP tool affinity entries', () => {
    const manifest = buildGeneratedTestAffinityManifest([
      {
        path: 'src/server.ts',
        text: "server.get('/api/widgets', async () => {});\n",
      },
      {
        path: 'src/mcp/sessionTools.ts',
        text: "{ name: 'session_review', description: 'review' }\n",
      },
      {
        path: 'tests/http.test.ts',
        text: "await request(app).get('/api/widgets');\n",
      },
      {
        path: 'tests/mcp.session.test.ts',
        text: "expect(names).toContain('session_review');\n",
      },
    ]);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.generator?.name).toBe('hoplon-test-affinity-extractor');
    expect(manifest.entries.map((entry) => entry.subject.kind)).toEqual([
      'mcp_tool',
      'route',
    ]);
    expect(manifest.entries[0]?.source).toBe('generated');
    expect(manifest.entries[0]?.tests[0]?.evidence[0]?.kind).toBe('generated_extractor');
    expect(manifest.entries.map((entry) => entry.id)).toEqual(
      [...manifest.entries.map((entry) => entry.id)].sort(),
    );
  });

  it('extracts exported symbol affinity entries when tests reference stable exported declarations', () => {
    const manifest = buildGeneratedTestAffinityManifest([
      {
        path: 'src/hoplon/widgets.ts',
        text: [
          'export interface WidgetContract { id: string }',
          'export type WidgetMode = "draft" | "live";',
          'export const widgetLimit = 10;',
          'export let widgetCursor = 0;',
          'export var legacyWidgetName = "legacy";',
          'export function createWidget() { return {}; }',
          'export class WidgetRegistry {}',
        ].join('\n'),
      },
      {
        path: 'tests/widgets.test.ts',
        text: [
          'expect(createWidget()).toEqual({});',
          'expect(WidgetRegistry).toBeDefined();',
          'expectTypeOf<WidgetContract>().toBeObject();',
          'expectTypeOf<WidgetMode>().toBeString();',
          'expect(widgetLimit).toBe(10);',
          'expect(widgetCursor).toBe(0);',
          'expect(legacyWidgetName).toBe("legacy");',
        ].join('\n'),
      },
    ]);

    expect(manifest.entries.map((entry) => entry.subject)).toEqual([
      {
        kind: 'exported_symbol',
        id: 'createWidget',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'createWidget' }],
      },
      {
        kind: 'exported_symbol',
        id: 'legacyWidgetName',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'legacyWidgetName' }],
      },
      {
        kind: 'exported_symbol',
        id: 'WidgetContract',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'WidgetContract' }],
      },
      {
        kind: 'exported_symbol',
        id: 'widgetCursor',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'widgetCursor' }],
      },
      {
        kind: 'exported_symbol',
        id: 'widgetLimit',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'widgetLimit' }],
      },
      {
        kind: 'exported_symbol',
        id: 'WidgetMode',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'WidgetMode' }],
      },
      {
        kind: 'exported_symbol',
        id: 'WidgetRegistry',
        definedIn: [{ path: 'src/hoplon/widgets.ts', selector: 'WidgetRegistry' }],
      },
    ]);
    expect(manifest.entries.every((entry) => entry.source === 'generated')).toBe(true);
    expect(manifest.entries.map((entry) => entry.id)).toEqual(
      [...manifest.entries.map((entry) => entry.id)].sort((a, b) => a.localeCompare(b)),
    );
    expect(manifest.entries.map((entry) => entry.tests[0])).toEqual(
      manifest.entries.map((entry) => ({
        path: 'tests/widgets.test.ts',
        evidence: [
          {
            kind: 'exported_symbol_reference',
            path: 'src/hoplon/widgets.ts',
            selector: entry.subject.id,
            detail: 'test text references a deterministic exported symbol name',
          },
        ],
      })),
    );
  });

  it('does not generate exported symbol entries without deterministic test references', () => {
    const manifest = buildGeneratedTestAffinityManifest([
      {
        path: 'src/hoplon/widgets.ts',
        text: 'export function createWidget() { return {}; }\n',
      },
      {
        path: 'tests/widgets.test.ts',
        text: 'expect(buildThing()).toEqual({});\n',
      },
      {
        path: 'src/hoplon/unreferenced.test.ts',
        text: 'export function createWidgetTestFixture() { return {}; }\n',
      },
    ]);

    expect(manifest.entries).toEqual([]);
  });
});
