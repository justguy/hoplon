/**
 * launcher/cli.ts — argv parsing and dispatch for the `hoplon` bin.
 *
 * Kept separate from the bin entry file so it can be unit-tested without a
 * subprocess. The `runCli` function returns a structured plan (parsed args
 * + command) that `main` executes; tests assert on the parsed plan and on
 * dispatch without ever starting real stdio/HTTP servers.
 */

import { collectFlags, flagsToWorkspace } from './cliFlags.js';
import { runStatus } from './status.js';
import { runMcpServe } from './mcpServe.js';
import type { McpTransportMode } from './mcpServe.js';
import { runHttpServe } from './httpServe.js';
import { parseQueryCommand, runQuery, QUERY_HELP_TEXT } from './query.js';
import { renderQueryHuman } from './queryHuman.js';
import { renderStatusHuman } from './statusHuman.js';
import {
  parseProjectCommand,
  runProjectCommand,
  PROJECT_HELP_TEXT,
} from './projectCli.js';
import { parseAgentToolProfileFlag } from '../transport/agentToolProfile.js';

import { HELP_TEXT } from './cliContract.js';
import type { ParsedCli, RunCliOptions } from './cliContract.js';

export { HELP_TEXT } from './cliContract.js';
export type { LauncherCommand, ParsedCli, RunCliOptions } from './cliContract.js';
export { QUERY_HELP_TEXT };

/** Parse argv (without node + script) into a structured command plan. */
export function parseCli(argv: readonly string[]): ParsedCli {
  if (argv.length === 0 || argv[0] === '--help' || argv[0] === '-h') {
    return { command: { kind: 'help' } };
  }
  if (argv[0] === '--version' || argv[0] === '-v') {
    return { command: { kind: 'version' } };
  }

  const [head, ...rest] = argv;
  const flags = collectFlags(rest);
  const workspace = flagsToWorkspace(flags);

  if (head === 'status') {
    const rawFormat = flags.get('format');
    if (rawFormat !== undefined && rawFormat !== 'json' && rawFormat !== 'human') {
      return { command: { kind: 'error', message: `Unknown status format: ${rawFormat}` } };
    }
    const format = rawFormat === 'human' ? 'human' : 'json';
    return { command: { kind: 'status', workspace, format } };
  }

  if (head === 'mcp') {
    if (rest[0] !== 'serve') {
      return { command: { kind: 'error', message: 'Unknown mcp subcommand. Did you mean `hoplon mcp serve`?' } };
    }
    const transport = (flags.get('transport') ?? 'stdio') as McpTransportMode;
    if (transport !== 'stdio' && transport !== 'sse') {
      return { command: { kind: 'error', message: `Unknown MCP transport: ${String(transport)}` } };
    }
    const portStr = flags.get('port');
    const port = portStr ? Number(portStr) : undefined;
    if (port !== undefined && Number.isNaN(port)) {
      return { command: { kind: 'error', message: `Invalid --port: ${String(portStr)}` } };
    }
    const agentToolProfile = parseAgentToolProfileFlag(flags.get('agent-profile'));
    if (agentToolProfile === null) {
      return {
        command: {
          kind: 'error',
          message:
            `Unknown agent profile: ${String(flags.get('agent-profile'))}. ` +
            'Supported profiles: default, strict-agent. Strict-agent mode fails closed on unsupported fallback surfaces.',
        },
      };
    }
    return {
      command: {
        kind: 'mcp-serve',
        workspace,
        transport,
        agentToolProfile,
        ...(port !== undefined ? { port } : {}),
      },
    };
  }

  if (head === 'http') {
    if (rest[0] !== 'serve') {
      return { command: { kind: 'error', message: 'Unknown http subcommand. Did you mean `hoplon http serve`?' } };
    }
    const host = flags.get('host') ?? '127.0.0.1';
    const portStr = flags.get('port') ?? '3000';
    const port = Number(portStr);
    if (Number.isNaN(port)) {
      return { command: { kind: 'error', message: `Invalid --port: ${portStr}` } };
    }
    const agentToolProfile = parseAgentToolProfileFlag(flags.get('agent-profile'));
    if (agentToolProfile === null) {
      return {
        command: {
          kind: 'error',
          message:
            `Unknown agent profile: ${String(flags.get('agent-profile'))}. ` +
            'Supported profiles: default, strict-agent. Strict-agent mode fails closed on unsupported fallback surfaces.',
        },
      };
    }
    const allowUnauthenticated = flags.get('allow-unauthenticated') === 'true';
    return {
      command: {
        kind: 'http-serve',
        workspace,
        host,
        port,
        agentToolProfile,
        allowUnauthenticated,
      },
    };
  }

  if (head === 'query') {
    if (rest.length === 0 || rest[0] === '--help' || rest[0] === '-h') {
      return { command: { kind: 'query-help' } };
    }
    const parsed = parseQueryCommand(rest);
    if (parsed.kind === 'error') {
      return { command: { kind: 'error', message: parsed.message } };
    }
    return {
      command: {
        kind: 'query',
        workspace,
        query: parsed.command,
        format: parsed.format,
      },
    };
  }

  if (head === 'project') {
    const parsed = parseProjectCommand(rest);
    if (parsed.kind === 'help') {
      return { command: { kind: 'project-help' } };
    }
    if (parsed.kind === 'error') {
      return { command: { kind: 'error', message: parsed.message } };
    }
    return {
      command: { kind: 'project', workspace, sub: parsed },
    };
  }

  return { command: { kind: 'error', message: `Unknown command: ${head}` } };
}

/**
 * Dispatch a parsed command plan. Exits the process at the end in the bin
 * entry; tests call this directly and assert on the return value.
 */
export async function runCli(
  argv: readonly string[],
  io: {
    stdout: (line: string) => void;
    stderr: (line: string) => void;
    version: string;
  },
  options: RunCliOptions = {},
): Promise<number> {
  const { command } = parseCli(argv);

  if (command.kind === 'error') {
    io.stderr(`hoplon: ${command.message}`);
    io.stderr(HELP_TEXT);
    return 2;
  }
  if (command.kind === 'help') {
    io.stdout(HELP_TEXT);
    return 0;
  }
  if (command.kind === 'query-help') {
    io.stdout(QUERY_HELP_TEXT);
    return 0;
  }
  if (command.kind === 'project-help') {
    io.stdout(PROJECT_HELP_TEXT);
    return 0;
  }
  if (command.kind === 'version') {
    io.stdout(io.version);
    return 0;
  }
  if (command.kind === 'status') {
    const semanticRuntime = await options.semanticRuntime?.(command.workspace);
    const report = await runStatus({
      ...command.workspace,
      ...(semanticRuntime !== undefined ? { semanticRuntime } : {}),
    });
    io.stdout(
      command.format === 'human' ? renderStatusHuman(report) : JSON.stringify(report, null, 2),
    );
    return 0;
  }
  if (command.kind === 'mcp-serve') {
    const semanticRuntime = await options.semanticRuntime?.(command.workspace);
    const handle = await runMcpServe({
      ...command.workspace,
      transport: command.transport,
      agentToolProfile: command.agentToolProfile,
      ...(semanticRuntime !== undefined ? { semanticRuntime } : {}),
      ...(command.port !== undefined ? { port: command.port } : {}),
    });
    const label =
      handle.transport === 'sse'
        ? `MCP SSE serving on port ${handle.port ?? '?'}`
        : 'MCP stdio serving on stdin/stdout';
    io.stderr(label);
    await waitForever();
    return 0;
  }
  if (command.kind === 'http-serve') {
    const semanticRuntime = await options.semanticRuntime?.(command.workspace);
    const handle = await runHttpServe({
      ...command.workspace,
      host: command.host,
      port: command.port,
      agentToolProfile: command.agentToolProfile,
      allowUnauthenticated: command.allowUnauthenticated,
      ...(semanticRuntime !== undefined ? { semanticRuntime } : {}),
    });
    io.stderr(`Hoplon HTTP serving on http://${handle.host ?? '?'}:${handle.port ?? '?'}`);
    await waitForever();
    return 0;
  }
  if (command.kind === 'query') {
    const envelope = await runQuery({
      workspace: command.workspace,
      command: command.query,
    });
    if (command.format === 'human') {
      io.stdout(renderQueryHuman(envelope));
    } else {
      io.stdout(JSON.stringify(envelope, null, 2));
    }
    return envelope.ok ? 0 : 1;
  }
  if (command.kind === 'project') {
    const outcome = runProjectCommand(command.workspace, command.sub);
    if (outcome.ok) {
      io.stdout(JSON.stringify(outcome.body, null, 2));
      return 0;
    }
    io.stderr(`hoplon: [${outcome.errorKind}] ${outcome.message}`);
    return 1;
  }
  return 1;
}

function waitForever(): Promise<void> {
  return new Promise<void>(() => {
    // Intentionally unresolved; the host process will receive SIGTERM/SIGINT.
  });
}
