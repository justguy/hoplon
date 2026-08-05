/**
 * launcher/query.ts — `hoplon query` read-only intelligence subcommands.
 *
 * Distinct surface from the launcher's status/serve commands. Exposes only
 * materially-real, read-only engine operations:
 *
 *   - `query capabilities` → engine.describeCapabilities()
 *   - `query skeleton`     → engine.extractStructuralTemplate() (live FS)
 *   - `query structure`    → engine.queryStructure()             (live FS)
 *   - `query search`       → engine.searchSymbols()               (live FS, t-056)
 *   - `query project`      → engine.describeProject()             (live FS, t-056)
 *
 * Read-only invariant: no subcommand here calls createSnapshot,
 * revertUncontracted, dryRun, or any write-capable path. The envelope is
 * machine-readable by default (JSON). A --format human path exists for
 * debugging parity, but never replaces the JSON output.
 */

import type { ExtractStructuralTemplateRequest } from '../contracts/structuralTemplate.js';
import type { QueryStructureRequest, QueryLanguage } from '../contracts/queryStructure.js';
import type {
  SearchSymbolsRequest,
  SearchableSymbolKind,
} from '../contracts/searchSymbols.js';
import type { DescribeProjectRequest } from '../contracts/describeProject.js';
import type {
  SeeCodebaseIntent,
  SeeCodebaseMode,
  SeeCodebaseRequest,
  SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import type { HoplonEngine } from '../engine/types.js';
import { resolveLauncherWorkspace } from './config.js';
import type { LauncherWorkspaceConfig, LauncherWorkspaceInput } from './config.js';
import { createReadOnlyQueryEngine } from './queryEngine.js';
import { generateQueryIds } from './queryFlags.js';
import { parseQueryCommandTokens } from './queryParse.js';

export type QueryFormat = 'json' | 'human';

export type QueryCommand =
  | { kind: 'capabilities' }
  | { kind: 'skeleton'; files: string[] }
  | {
      kind: 'structure';
      files: string[];
      language: QueryLanguage;
      pattern: string;
      queryId: string;
    }
  | {
      kind: 'search';
      namePattern: string;
      files?: string[];
      kinds?: SearchableSymbolKind[];
      maxResults?: number;
    }
  | {
      kind: 'project';
      maxFiles?: number;
      samplePathsPerLanguage?: number;
    }
  | {
      kind: 'see';
      intent: SeeCodebaseIntent;
      targets: SeeCodebaseTarget[];
      mode?: SeeCodebaseMode;
      strict?: boolean;
      includeProvenance?: boolean;
      maxBytes?: number;
      maxResults?: number;
    };

export type ParsedQueryCommand =
  | { kind: 'parsed'; command: QueryCommand; format: QueryFormat }
  | { kind: 'error'; message: string };

export interface QueryEnvelope<T> {
  ok: boolean;
  version: 1;
  command: string;
  engineId: string;
  data?: T;
  error?: { kind: string; message: string };
}

export interface RunQueryOptions {
  workspace: LauncherWorkspaceInput;
  command: QueryCommand;
  /** Injection point for tests. Defaults to the read-only query engine factory. */
  engineFactory?: (workspace: LauncherWorkspaceConfig) => Promise<HoplonEngine>;
  /** Injection point for tests. Defaults to `Date.now`. */
  now?: () => number;
}

export type QueryCommandLabel =
  | 'query capabilities'
  | 'query skeleton'
  | 'query structure'
  | 'query search'
  | 'query project'
  | 'query see';

export const parseQueryCommand = parseQueryCommandTokens;

export async function runQuery<T = unknown>(
  options: RunQueryOptions,
): Promise<QueryEnvelope<T>> {
  const workspace = resolveLauncherWorkspace(options.workspace);
  const label = labelFor(options.command);
  const now = options.now ?? Date.now;

  let engine: HoplonEngine;
  try {
    engine = await (options.engineFactory
      ? options.engineFactory(workspace)
      : createReadOnlyQueryEngine(workspace));
  } catch (err) {
    return buildErrorEnvelope<T>(label, workspace.engineId, err);
  }

  const ids = generateQueryIds(workspace, now);

  try {
    if (options.command.kind === 'capabilities') {
      const result = await engine.describeCapabilities({ correlationId: ids.correlationId });
      return buildOkEnvelope<T>(label, workspace.engineId, result as unknown as T);
    }
    if (options.command.kind === 'skeleton') {
      const req: ExtractStructuralTemplateRequest = {
        ...ids,
        files: options.command.files,
      };
      const result = await engine.extractStructuralTemplate(req);
      return buildOkEnvelope<T>(label, workspace.engineId, result as unknown as T);
    }
    if (options.command.kind === 'structure') {
      const req: QueryStructureRequest = {
        ...ids,
        files: options.command.files,
        queries: [
          {
            id: options.command.queryId,
            language: options.command.language,
            pattern: options.command.pattern,
          },
        ],
      };
      const result = await engine.queryStructure(req);
      return buildOkEnvelope<T>(label, workspace.engineId, result as unknown as T);
    }
    if (options.command.kind === 'search') {
      const req: SearchSymbolsRequest = {
        ...ids,
        namePattern: options.command.namePattern,
        ...(options.command.files !== undefined ? { files: options.command.files } : {}),
        ...(options.command.kinds !== undefined ? { kinds: options.command.kinds } : {}),
        ...(options.command.maxResults !== undefined
          ? { maxResults: options.command.maxResults }
          : {}),
      };
      const result = await engine.searchSymbols(req);
      return buildOkEnvelope<T>(label, workspace.engineId, result as unknown as T);
    }
    if (options.command.kind === 'project') {
      const req: DescribeProjectRequest = {
        ...ids,
        ...(options.command.maxFiles !== undefined ? { maxFiles: options.command.maxFiles } : {}),
        ...(options.command.samplePathsPerLanguage !== undefined
          ? { samplePathsPerLanguage: options.command.samplePathsPerLanguage }
          : {}),
      };
      const result = await engine.describeProject(req);
      return buildOkEnvelope<T>(label, workspace.engineId, result as unknown as T);
    }
    if (options.command.kind === 'see') {
      const req: SeeCodebaseRequest = {
        ...ids,
        intent: options.command.intent,
        targets: options.command.targets,
        ...(options.command.mode !== undefined ? { mode: options.command.mode } : {}),
        ...(options.command.strict !== undefined ? { strict: options.command.strict } : {}),
        ...(options.command.includeProvenance !== undefined
          ? { includeProvenance: options.command.includeProvenance }
          : {}),
        ...(options.command.maxBytes !== undefined ? { maxBytes: options.command.maxBytes } : {}),
        ...(options.command.maxResults !== undefined
          ? { maxResults: options.command.maxResults }
          : {}),
      };
      const result = await engine.seeCodebase(req);
      return buildOkEnvelope<T>(label, workspace.engineId, result as unknown as T);
    }
  } catch (err) {
    return buildErrorEnvelope<T>(label, workspace.engineId, err);
  }
  return buildErrorEnvelope<T>(label, workspace.engineId, new Error('unreachable query dispatch'));
}

export const QUERY_HELP_TEXT = `hoplon query — read-only intelligence commands

Usage:
  hoplon query capabilities [--format json|human]
  hoplon query skeleton --file <path> [--file <path>...] [--format json|human]
  hoplon query structure --file <path> [--file <path>...] \\
                         --language <js|ts|javascript|typescript|tsx> \\
                         --pattern <s-expression> [--query-id <id>] [--format json|human]
  hoplon query search --pattern <regex> [--file <path>...] \\
                      [--kind function|class|interface|type|enum|method|export]... \\
                      [--max-results <n>] [--format json|human]
  hoplon query project [--max-files <n>] [--sample-paths <n>] [--format json|human]
  hoplon query see --intent <name> \\
                   [--target-file <path>]... [--target-symbol <name>[@<file>]]... \\
                   [--target-pattern <regex>[@<scope1,scope2>]]... [--target-project] \\
                   [--mode auto|structural|raw|skeleton] [--strict] \\
                   [--no-provenance] [--max-bytes <n>] [--max-results <n>] \\
                   [--format json|human]

Every subcommand is read-only. No snapshot creation, revert, or dry-run path.
Output is a machine-readable envelope on stdout; errors go to stderr.

\`query search\` and \`query project\` are AST-aware: they only see *declared*
JS/TS symbols (functions, classes, methods, exports, top-level types). They
do NOT replace raw text grep for docs, logs, comments, env vars, or
arbitrary string literals.`;

function buildOkEnvelope<T>(
  command: QueryCommandLabel,
  engineId: string,
  data: T,
): QueryEnvelope<T> {
  return { ok: true, version: 1, command, engineId, data };
}

function buildErrorEnvelope<T>(
  command: QueryCommandLabel,
  engineId: string,
  err: unknown,
): QueryEnvelope<T> {
  const kind = extractErrorKind(err);
  const message = err instanceof Error ? err.message : String(err);
  return { ok: false, version: 1, command, engineId, error: { kind, message } };
}

function extractErrorKind(err: unknown): string {
  if (err && typeof err === 'object') {
    const maybe = err as { kind?: unknown; name?: unknown };
    if (typeof maybe.kind === 'string' && maybe.kind.length > 0) return maybe.kind;
    if (typeof maybe.name === 'string' && maybe.name.length > 0) return maybe.name;
  }
  return 'unknown_error';
}

function labelFor(cmd: QueryCommand): QueryCommandLabel {
  if (cmd.kind === 'capabilities') return 'query capabilities';
  if (cmd.kind === 'skeleton') return 'query skeleton';
  if (cmd.kind === 'structure') return 'query structure';
  if (cmd.kind === 'search') return 'query search';
  if (cmd.kind === 'project') return 'query project';
  return 'query see';
}
