/** Public parser-pool facade. Runtime mechanics live beside their shared types. */

export { createParserPool } from './parserPoolRuntime.js';
export type {
  ParseRequest,
  ParserPool,
  ParserPoolOptions,
  ParserPoolStats,
  SerializedNode,
  SerializedSyntaxTree,
  SupportedLanguage,
} from './parserPoolTypes.js';
