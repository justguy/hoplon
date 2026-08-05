import type { TreeSitterQuery } from '../contracts/queryStructure.js';

const EXTRACT_INTERFACE_TS: TreeSitterQuery = {
  id: 'extract-types',
  language: 'typescript',
  pattern: `(interface_declaration name: (type_identifier) @type_name)`,
};

const EXTRACT_TYPE_ALIAS_TS: TreeSitterQuery = {
  id: 'extract-types',
  language: 'typescript',
  pattern: `(type_alias_declaration name: (type_identifier) @type_name)`,
};

const EXTRACT_INTERFACE_TSX: TreeSitterQuery = {
  id: 'extract-types',
  language: 'tsx',
  pattern: `(interface_declaration name: (type_identifier) @type_name)`,
};

const EXTRACT_TYPE_ALIAS_TSX: TreeSitterQuery = {
  id: 'extract-types',
  language: 'tsx',
  pattern: `(type_alias_declaration name: (type_identifier) @type_name)`,
};

export const STD_QUERY_TYPES: readonly TreeSitterQuery[] = [
  EXTRACT_INTERFACE_TS,
  EXTRACT_TYPE_ALIAS_TS,
  EXTRACT_INTERFACE_TSX,
  EXTRACT_TYPE_ALIAS_TSX,
];

export const DEFAULT_TEMPLATE_QUERY_ID = 'structural-template';
