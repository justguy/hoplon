/**
 * mcp/index.ts — public barrel for the Hoplon MCP wrapper.
 *
 * Consumers import from '@phalanx/hoplon' (re-exported via src/index.ts)
 * or directly from this barrel for internal use.
 */

export { createHoplonMcpServer } from './server.js';
export type { McpServerOptions } from './server.js';

export {
  createStdioTransport,
  createHttpSseTransport,
} from './transports.js';
export type { HttpSseServer } from './transports.js';
