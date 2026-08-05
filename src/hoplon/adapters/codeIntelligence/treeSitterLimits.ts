/**
 * adapters/codeIntelligence/treeSitterLimits.ts — shared tree-sitter support
 * envelope surfaced both by the adapter and launcher truth reporting.
 */

export const TREE_SITTER_SUPPORTED_LANGUAGES = [
  'javascript',
  'typescript',
  'tsx',
] as const;
export type TreeSitterSupportedLanguage =
  (typeof TREE_SITTER_SUPPORTED_LANGUAGES)[number];

export const TREE_SITTER_SUPPORTED_EXTENSIONS = [
  '.js',
  '.mjs',
  '.cjs',
  '.jsx',
  '.ts',
  '.tsx',
] as const;

/** Hard ceiling for parse input — safety net distinct from engine maxFileBytes. */
export const TREE_SITTER_MAX_FILE_BYTES = 10 * 1024 * 1024; // 10 MB

/** Default parse timeout when no AbortSignal is supplied directly to parse(). */
export const TREE_SITTER_DEFAULT_PARSE_TIMEOUT_MS = 5000;
