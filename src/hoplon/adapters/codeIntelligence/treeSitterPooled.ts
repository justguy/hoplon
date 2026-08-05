/**
 * adapters/codeIntelligence/treeSitterPooled.ts
 *
 * Optional pool-backed CodeIntelligenceAdapter.
 *
 * When a caller supplies a ParserPool, parse() dispatches to the pool.
 * getTopLevelSymbols() operates on the already-hydrated RefinedSyntaxTree
 * (no parse involved — no parallelism needed).
 *
 * Phase 1 behavior is UNCHANGED: createTreeSitterIntelligence remains the
 * default. This factory is an opt-in alternative for callers that want
 * CPU-isolated parses.
 *
 * H20 compliance: byteRange values in the returned RefinedSyntaxTree are
 * UTF-8 byte offsets (guaranteed by parserWorker.ts charPosToBytePos).
 * The hydrateFromSerialized function trusts and forwards those values.
 */

import { AdapterError } from '../../contracts/errors.js';
import type { CodeIntelligenceAdapter, SyntaxTree, Symbol } from '../codeIntelligence.js';
import type { RefinedSyntaxTree, RefinedSyntaxNode } from './treeSitter.js';
import { detectLanguage } from './treeSitter.js';
import type { ParserPool, SerializedSyntaxTree, SerializedNode } from '../../concurrency/parserPool.js';

// ---------------------------------------------------------------------------
// Sentinel IDs for adapter-layer errors
// ---------------------------------------------------------------------------

const SENTINEL_ENGINE_ID = 'adapter';
const SENTINEL_CORR_ID = 'adapter-pooled';

// ---------------------------------------------------------------------------
// Hydration — rebuild RefinedSyntaxNode tree from flat serialized form
// ---------------------------------------------------------------------------

/**
 * Reconstruct a RefinedSyntaxNode from a flat SerializedNode array.
 * Children are resolved lazily via getters to avoid redundant object allocation.
 */
function hydrateNode(nodes: readonly SerializedNode[], index: number): RefinedSyntaxNode {
  const serialized = nodes[index]!;
  return {
    kind: serialized.kind,
    byteRange: serialized.byteRange,
    text: serialized.text,
    get children(): RefinedSyntaxNode[] {
      return serialized.childIndexes.map((i) => hydrateNode(nodes, i));
    },
    get namedChildren(): RefinedSyntaxNode[] {
      return serialized.namedChildIndexes.map((i) => hydrateNode(nodes, i));
    },
  };
}

/**
 * Reconstruct a RefinedSyntaxTree from a SerializedSyntaxTree.
 *
 * The root node is nodes[0] (the visit() function in parserWorker always
 * assigns rootIndex = 0 for the root — the pre-order DFS ensures this).
 * We use rootByteRange/rootKind/rootText from the top-level fields for
 * the root node to avoid relying on nodes[0] being the root.
 */
function hydrateFromSerialized(serialized: SerializedSyntaxTree): RefinedSyntaxTree {
  const { nodes, rootKind, rootByteRange, rootText, language, grammarVersion } = serialized;

  // The root is always at index 0 in the flat array (pre-order DFS in worker)
  const rootNode: RefinedSyntaxNode = {
    kind: rootKind,
    byteRange: rootByteRange,
    text: rootText,
    get children(): RefinedSyntaxNode[] {
      const root = nodes[0];
      if (!root) return [];
      return root.childIndexes.map((i) => hydrateNode(nodes, i));
    },
    get namedChildren(): RefinedSyntaxNode[] {
      const root = nodes[0];
      if (!root) return [];
      return root.namedChildIndexes.map((i) => hydrateNode(nodes, i));
    },
  };

  return { rootNode, language, grammarVersion };
}

// ---------------------------------------------------------------------------
// Top-level symbol extraction (copied from treeSitter.ts — shares no state)
// ---------------------------------------------------------------------------

const TOP_LEVEL_KINDS = new Set([
  'function_declaration',
  'generator_function_declaration',
  'class_declaration',
  'lexical_declaration',
  'variable_declaration',
  'export_statement',
  'import_statement',
]);

function extractTopLevelSymbolsFromFacade(namedChildren: RefinedSyntaxNode[]): Symbol[] {
  const symbols: Symbol[] = [];
  for (const child of namedChildren) {
    if (!TOP_LEVEL_KINDS.has(child.kind)) continue;
    const name = extractNameFromFacade(child);
    if (name !== null) {
      symbols.push({ name, kind: child.kind, byteRange: child.byteRange });
    }
  }
  return symbols;
}

function extractNameFromFacade(node: RefinedSyntaxNode): string | null {
  switch (node.kind) {
    case 'function_declaration':
    case 'generator_function_declaration': {
      for (const child of node.namedChildren) {
        if (child.kind === 'identifier' || child.kind === 'type_identifier') {
          return child.text;
        }
      }
      return null;
    }

    case 'class_declaration': {
      for (const child of node.namedChildren) {
        if (child.kind === 'type_identifier' || child.kind === 'identifier') {
          return child.text;
        }
      }
      return null;
    }

    case 'lexical_declaration':
    case 'variable_declaration': {
      for (const child of node.namedChildren) {
        if (child.kind === 'variable_declarator') {
          const nameNode = child.namedChildren[0];
          return nameNode ? nameNode.text : null;
        }
      }
      return null;
    }

    case 'export_statement': {
      for (const child of node.namedChildren) {
        if (
          child.kind === 'function_declaration' ||
          child.kind === 'generator_function_declaration' ||
          child.kind === 'class_declaration' ||
          child.kind === 'lexical_declaration' ||
          child.kind === 'variable_declaration'
        ) {
          return extractNameFromFacade(child);
        }
      }
      return null;
    }

    case 'import_statement': {
      for (const child of node.namedChildren) {
        if (child.kind === 'string') {
          return child.text.replace(/^['"`]|['"`]$/g, '');
        }
      }
      return null;
    }

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface TreeSitterPooledOptions {
  /** Absolute path to vendor/grammars/ — passed to pool constructor if pool not yet created. */
  grammarsDir: string;
  /** An already-created ParserPool instance. */
  pool: ParserPool;
}

/**
 * Create a pool-backed CodeIntelligenceAdapter.
 *
 * parse() dispatches to the provided pool; getTopLevelSymbols() operates on
 * the hydrated RefinedSyntaxTree locally (no parse involved).
 *
 * Optional LSP methods are absent (feature-detection friendly — same as base adapter).
 */
export async function createTreeSitterIntelligenceWithPool(
  opts: TreeSitterPooledOptions
): Promise<CodeIntelligenceAdapter> {
  const { pool } = opts;

  async function parse(
    file: string,
    content: Uint8Array,
    signal?: AbortSignal
  ): Promise<RefinedSyntaxTree> {
    const language = detectLanguage(file);
    if (language === null) {
      const ext = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '(none)';
      throw new AdapterError(
        {
          kind: 'parser_init_failed',
          engineId: SENTINEL_ENGINE_ID,
          correlationId: SENTINEL_CORR_ID,
          cause: { reason: 'unsupported_extension', extension: ext, file },
        },
        `Unsupported extension "${ext}" (file: ${file}). Supported: .js .mjs .cjs .jsx .ts .tsx`
      );
    }

    const serialized = await pool.parse({ file, content, language }, signal);
    return hydrateFromSerialized(serialized);
  }

  function getTopLevelSymbols(tree: SyntaxTree): Symbol[] {
    const root = (tree as RefinedSyntaxTree).rootNode;
    if (!Array.isArray(root.namedChildren) || root.namedChildren.length === 0) {
      return [];
    }
    return extractTopLevelSymbolsFromFacade(root.namedChildren as RefinedSyntaxNode[]);
  }

  return { parse, getTopLevelSymbols };
}
