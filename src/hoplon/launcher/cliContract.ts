/** Public launcher CLI plan and help-text contract. */

import type { McpTransportMode } from './mcpServe.js';
import type { LauncherWorkspaceInput } from './config.js';
import type { SemanticRuntimeAdapters } from '../engine/factory.js';
import type { QueryCommand, QueryFormat } from './query.js';
import type { ProjectSubcommand } from './projectCli.js';
import type { AgentToolProfile } from '../transport/agentToolProfile.js';

export type LauncherCommand =
  | { kind: 'help' }
  | { kind: 'version' }
  | { kind: 'query-help' }
  | { kind: 'project-help' }
  | { kind: 'status'; workspace: LauncherWorkspaceInput; format: 'json' | 'human' }
  | {
      kind: 'mcp-serve';
      workspace: LauncherWorkspaceInput;
      transport: McpTransportMode;
      port?: number;
      agentToolProfile: AgentToolProfile;
    }
  | {
      kind: 'http-serve';
      workspace: LauncherWorkspaceInput;
      host: string;
      port: number;
      agentToolProfile: AgentToolProfile;
      allowUnauthenticated: boolean;
    }
  | {
      kind: 'query';
      workspace: LauncherWorkspaceInput;
      query: QueryCommand;
      format: QueryFormat;
    }
  | {
      kind: 'project';
      workspace: LauncherWorkspaceInput;
      sub: ProjectSubcommand;
    };

export interface ParsedCli {
  command: LauncherCommand | { kind: 'error'; message: string };
}

export interface RunCliOptions {
  readonly semanticRuntime?: (
    workspace: LauncherWorkspaceInput,
  ) => Promise<SemanticRuntimeAdapters | undefined>;
}

export const HELP_TEXT = `hoplon — deterministic repository boundary for AI coding agents

Usage:
  hoplon status [--root <dir>] [--format json|human]
  hoplon mcp serve [--transport stdio|sse] [--port <n>] [--root <dir>] [--agent-profile default|strict-agent]
  hoplon http serve [--host <h>] [--port <n>] [--root <dir>] [--agent-profile default|strict-agent] [--allow-unauthenticated]
  hoplon query <subcommand> [flags]    (read-only; see \`hoplon query --help\`)
  hoplon project <subcommand> [flags]  (multi-project registration; see \`hoplon project --help\`)
  hoplon --help
  hoplon --version

Common flags:
  --root <dir>          workspace root (default: CWD)
  --db <path>           snapshot registry path (default: <root>/.hoplon/hoplon.db)
  --git-repo-dir <dir>  internal git repo dir (default: .hoplon/repo)
  --grammars-dir <dir>  tree-sitter grammars dir
  --engine-id <id>      engine identity (default: local-0)
  --agent-profile <p>   agent tool surface: default or strict-agent

The launcher subcommands (status, mcp serve, http serve) bootstrap the
engine and expose the existing MCP/HTTP surfaces. The \`query\` subcommand
group is a separate read-only intelligence surface and never creates,
reverts, or dry-runs snapshots.

\`http serve\` refuses to bind to a non-loopback --host (anything other than
127.0.0.1, ::1, localhost) because that surface is unauthenticated. Pass
--allow-unauthenticated to override (unsafe), or embed programmatically with
an auth registry.

Future agent installations should declare this server in both .mcp.json and
.codex/config.toml with the same \`hoplon mcp serve --root <dir>
--grammars-dir <dir>\` command so MCP discovery and launcher project
registration use the same root. Project registration and folder-policy
mutation remain host/launcher-owned; a trusted shell-capable agent may use
\`hoplon project register\`, while an MCP-only agent must ask the
host/operator.`;
