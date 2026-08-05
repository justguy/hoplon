/**
 * operations/searchSymbolsQueries.ts — tree-sitter query bundles for the
 * t-056 searchSymbols operation. Split from searchSymbols.ts so the engine
 * op stays under the 300-line architecture cap.
 *
 * Each bundle targets a single SearchableSymbolKind and carries an
 * operation-local queryId so the engine op can map captures back to kinds
 * deterministically.
 */

import type { TreeSitterQuery } from '../contracts/queryStructure.js';
import type { SearchableSymbolKind } from '../contracts/searchSymbols.js';

export const CLASS_DECL_QUERIES: readonly TreeSitterQuery[] = [
  {
    id: 'search-class-decl',
    language: 'javascript',
    pattern: `(class_declaration name: (identifier) @class_name)`,
  },
  {
    id: 'search-class-decl',
    language: 'typescript',
    pattern: `(class_declaration name: (type_identifier) @class_name)`,
  },
  {
    id: 'search-class-decl',
    language: 'tsx',
    pattern: `(class_declaration name: (type_identifier) @class_name)`,
  },
];

export const INTERFACE_QUERIES: readonly TreeSitterQuery[] = [
  {
    id: 'search-interface',
    language: 'typescript',
    pattern: `(interface_declaration name: (type_identifier) @type_name)`,
  },
  {
    id: 'search-interface',
    language: 'tsx',
    pattern: `(interface_declaration name: (type_identifier) @type_name)`,
  },
];

export const TYPE_ALIAS_QUERIES: readonly TreeSitterQuery[] = [
  {
    id: 'search-type-alias',
    language: 'typescript',
    pattern: `(type_alias_declaration name: (type_identifier) @type_name)`,
  },
  {
    id: 'search-type-alias',
    language: 'tsx',
    pattern: `(type_alias_declaration name: (type_identifier) @type_name)`,
  },
];

export const ENUM_QUERIES: readonly TreeSitterQuery[] = [
  {
    id: 'search-enum',
    language: 'typescript',
    pattern: `(enum_declaration name: (identifier) @enum_name)`,
  },
  {
    id: 'search-enum',
    language: 'tsx',
    pattern: `(enum_declaration name: (identifier) @enum_name)`,
  },
];

/** Maps a kind to the queryId(s) that produce its matches. */
export const KIND_TO_QUERY_IDS: Record<SearchableSymbolKind, readonly string[]> = {
  function: ['extract-function-signatures'],
  class: ['search-class-decl'],
  interface: ['search-interface'],
  type: ['search-type-alias'],
  enum: ['search-enum'],
  method: ['extract-class-methods'],
  export: ['extract-exports'],
};

export function queryIdToKind(queryId: string): SearchableSymbolKind {
  switch (queryId) {
    case 'extract-function-signatures':
      return 'function';
    case 'search-class-decl':
      return 'class';
    case 'search-interface':
      return 'interface';
    case 'search-type-alias':
      return 'type';
    case 'search-enum':
      return 'enum';
    case 'extract-class-methods':
      return 'method';
    case 'extract-exports':
      return 'export';
    default:
      return 'function';
  }
}
