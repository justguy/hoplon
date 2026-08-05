import type { QueryMatch } from '../contracts/queryStructure.js';
import type {
  ExportEntry,
  ImportEntry,
  StructuralTemplate,
  StructuralTemplateFile,
  SymbolKind,
  TypeEntry,
} from '../contracts/structuralTemplate.js';

interface MatchBuckets {
  exportMatches: QueryMatch[];
  importMatches: QueryMatch[];
  typeMatches: QueryMatch[];
}

export function assembleStructuralTemplate(
  requestedFiles: string[],
  matches: QueryMatch[],
  queryId: string,
  snapshotRef: string | null,
): StructuralTemplate {
  const fileMap = new Map<string, MatchBuckets>();
  for (const file of requestedFiles) {
    fileMap.set(file, {
      exportMatches: [],
      importMatches: [],
      typeMatches: [],
    });
  }

  for (const match of matches) {
    const bucket = fileMap.get(match.path);
    if (!bucket) continue;
    if (match.queryId === 'extract-exports') {
      bucket.exportMatches.push(match);
    } else if (match.queryId === 'extract-imports') {
      bucket.importMatches.push(match);
    } else if (match.queryId === 'extract-types') {
      bucket.typeMatches.push(match);
    }
  }

  const sortedPaths = [...fileMap.keys()].sort((left, right) =>
    left < right ? -1 : left > right ? 1 : 0,
  );
  const files: StructuralTemplateFile[] = sortedPaths.map((path) => {
    const bucket = fileMap.get(path)!;
    const exports: ExportEntry[] = bucket.exportMatches.map((match) => ({
      name: extractIdentifierName(match.text),
      kind: nodeKindToSymbolKind(match.nodeKind),
      signature: match.text,
    }));
    const imports: ImportEntry[] = groupImports(bucket.importMatches);
    const types: TypeEntry[] = bucket.typeMatches.map((match) => ({
      name: match.text,
      declaration: match.text,
    }));
    return { path, exports, imports, types };
  });
  return { files, queryId, snapshotRef };
}

function extractIdentifierName(declarationText: string): string {
  const firstIdentifier = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/.exec(
    declarationText,
  );
  if (firstIdentifier) {
    const keywords = new Set([
      'function',
      'class',
      'const',
      'let',
      'var',
      'export',
      'default',
      'interface',
      'type',
      'enum',
      'async',
      'abstract',
      'declare',
    ]);
    const tokenPattern = /\b([A-Za-z_$][A-Za-z0-9_$]*)\b/g;
    let position = 0;
    let match: RegExpExecArray | null;
    while ((match = tokenPattern.exec(declarationText)) !== null) {
      position++;
      if (!keywords.has(match[1]!)) return match[1]!;
      if (position > 10) break;
    }
  }
  return declarationText.split(/\s/)[0] ?? declarationText;
}

function nodeKindToSymbolKind(nodeKind: string): SymbolKind {
  switch (nodeKind) {
    case 'function_declaration':
    case 'generator_function_declaration':
      return 'function';
    case 'class_declaration':
      return 'class';
    case 'interface_declaration':
      return 'interface';
    case 'type_alias_declaration':
      return 'type';
    case 'enum_declaration':
      return 'enum';
    case 'variable_declaration':
    case 'lexical_declaration':
      return 'variable';
    default:
      return 'unknown';
  }
}

function groupImports(importMatches: QueryMatch[]): ImportEntry[] {
  return importMatches.map((match) => {
    const raw = match.text;
    const source =
      raw.startsWith('"') || raw.startsWith("'") || raw.startsWith('`')
        ? raw.slice(1, -1)
        : raw;
    return { source, symbols: [] };
  });
}
