import { createHash } from 'node:crypto';

import type {
  TestAffinityEntry,
  TestAffinityEvidence,
  TestAffinityManifest,
} from '../contracts/testAffinity.js';

export interface TestAffinityExtractorDocument {
  path: string;
  text: string;
}

export function buildGeneratedTestAffinityManifest(
  documents: readonly TestAffinityExtractorDocument[],
): TestAffinityManifest {
  const sortedDocs = [...documents].sort((a, b) => a.path.localeCompare(b.path));
  const tests = sortedDocs.filter((doc) => isTestPath(doc.path));
  const entries: TestAffinityEntry[] = [
    ...routeEntries(sortedDocs, tests),
    ...mcpToolEntries(sortedDocs, tests),
    ...exportedSymbolEntries(sortedDocs, tests),
  ].sort((a, b) => a.id.localeCompare(b.id));
  return {
    schemaVersion: 1,
    generator: {
      name: 'hoplon-test-affinity-extractor',
      version: '1',
      inputDigest: inputDigest(sortedDocs),
    },
    entries,
  };
}

function routeEntries(
  docs: readonly TestAffinityExtractorDocument[],
  tests: readonly TestAffinityExtractorDocument[],
): TestAffinityEntry[] {
  const out: TestAffinityEntry[] = [];
  for (const doc of docs) {
    for (const route of extractRoutes(doc.text)) {
      const matchingTests = tests
        .filter((test) => test.text.includes(route.literal))
        .map((test) => testRef(test.path, routeEvidence(route.literal, doc.path)));
      if (matchingTests.length === 0) continue;
      out.push({
        id: `generated:route:${sanitizeId(route.literal)}:${sanitizeId(doc.path)}`,
        source: 'generated',
        subject: {
          kind: 'route',
          id: route.literal,
          definedIn: [{ path: doc.path, selector: route.method }],
        },
        tests: matchingTests,
      });
    }
  }
  return out;
}

function mcpToolEntries(
  docs: readonly TestAffinityExtractorDocument[],
  tests: readonly TestAffinityExtractorDocument[],
): TestAffinityEntry[] {
  const out: TestAffinityEntry[] = [];
  for (const doc of docs) {
    for (const toolName of extractMcpToolNames(doc.text)) {
      const matchingTests = tests
        .filter((test) => test.text.includes(toolName))
        .map((test) => testRef(test.path, toolEvidence(toolName, doc.path)));
      if (matchingTests.length === 0) continue;
      out.push({
        id: `generated:mcp_tool:${sanitizeId(toolName)}:${sanitizeId(doc.path)}`,
        source: 'generated',
        subject: {
          kind: 'mcp_tool',
          id: toolName,
          definedIn: [{ path: doc.path }],
        },
        tests: matchingTests,
      });
    }
  }
  return out;
}

function exportedSymbolEntries(
  docs: readonly TestAffinityExtractorDocument[],
  tests: readonly TestAffinityExtractorDocument[],
): TestAffinityEntry[] {
  const out: TestAffinityEntry[] = [];
  for (const doc of docs.filter((candidate) => isSourcePath(candidate.path))) {
    for (const symbol of extractExportedSymbols(doc.text)) {
      const matchingTests = tests
        .filter((test) => referencesIdentifier(test.text, symbol.name))
        .map((test) => testRef(test.path, exportedSymbolEvidence(symbol.name, doc.path)));
      if (matchingTests.length === 0) continue;
      out.push({
        id: `generated:exported_symbol:${sanitizeId(symbol.name)}:${sanitizeId(doc.path)}`,
        source: 'generated',
        subject: {
          kind: 'exported_symbol',
          id: symbol.name,
          definedIn: [{ path: doc.path, selector: symbol.selector }],
        },
        tests: matchingTests,
      });
    }
  }
  return out;
}

function testRef(
  path: string,
  evidence: TestAffinityEvidence,
): TestAffinityEntry['tests'][number] {
  return { path, evidence: [evidence] };
}

function routeEvidence(literal: string, sourcePath: string): TestAffinityEvidence {
  return {
    kind: 'generated_extractor',
    path: sourcePath,
    selector: literal,
    detail: 'test text references a deterministic route literal',
  };
}

function toolEvidence(toolName: string, sourcePath: string): TestAffinityEvidence {
  return {
    kind: 'generated_extractor',
    path: sourcePath,
    selector: toolName,
    detail: 'test text references a deterministic MCP tool name',
  };
}

function exportedSymbolEvidence(symbolName: string, sourcePath: string): TestAffinityEvidence {
  return {
    kind: 'exported_symbol_reference',
    path: sourcePath,
    selector: symbolName,
    detail: 'test text references a deterministic exported symbol name',
  };
}

function extractRoutes(text: string): { method: string; literal: string }[] {
  const matches = text.matchAll(/\b(?:app|server)\.(get|post|put|patch|delete)\(\s*['"`]([^'"`]+)['"`]/gu);
  return [...matches].map((match) => ({
    method: match[1] ?? 'route',
    literal: match[2] ?? '',
  })).filter((route) => route.literal.length > 0);
}

function extractMcpToolNames(text: string): string[] {
  const matches = text.matchAll(/\bname:\s*['"`]([A-Za-z0-9_.:-]+)['"`]/gu);
  return [...new Set([...matches].map((match) => match[1] ?? '').filter(Boolean))]
    .sort();
}

function extractExportedSymbols(text: string): { name: string; selector: string }[] {
  const declarationPatterns = [
    /\bexport\s+(?:async\s+)?function\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+interface\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+type\s+([A-Za-z_$][\w$]*)/gu,
    /\bexport\s+(const|let|var)\s+([A-Za-z_$][\w$]*)/gu,
  ];
  const symbols = new Map<string, { name: string; selector: string }>();
  for (const pattern of declarationPatterns) {
    for (const match of text.matchAll(pattern)) {
      const name = match[2] ?? match[1] ?? '';
      if (name.length === 0 || symbols.has(name)) continue;
      symbols.set(name, {
        name,
        selector: name,
      });
    }
  }
  return [...symbols.values()].sort((a, b) => a.name.localeCompare(b.name));
}

function referencesIdentifier(text: string, identifier: string): boolean {
  return new RegExp(`(?<![A-Za-z0-9_$])${escapeRegExp(identifier)}(?![A-Za-z0-9_$])`, 'u')
    .test(text);
}

function isTestPath(path: string): boolean {
  return /(^|\/)(test|tests)\//u.test(path) || /\.test\.[cm]?[jt]sx?$/u.test(path);
}

function isSourcePath(path: string): boolean {
  return !isTestPath(path) && /\.[cm]?[jt]sx?$/u.test(path);
}

function inputDigest(docs: readonly TestAffinityExtractorDocument[]): string {
  const hash = createHash('sha256');
  for (const doc of docs) {
    hash.update(doc.path);
    hash.update('\0');
    hash.update(doc.text);
    hash.update('\0');
  }
  return `sha256:${hash.digest('hex')}`;
}

function sanitizeId(value: string): string {
  const sanitized = value.replace(/[^A-Za-z0-9_.-]+/gu, '_');
  return sanitized.length > 0 ? sanitized : 'unknown';
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}
