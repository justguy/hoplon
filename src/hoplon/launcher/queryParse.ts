/**
 * launcher/queryParse.ts — argv → ParsedQueryCommand for `hoplon query`.
 *
 * Extracted from query.ts so the dispatcher and parser each stay under the
 * 300-line architecture cap as the read-only intelligence surface grows
 * (t-056 added `search` and `project` subcommands).
 */

import {
  SUPPORTED_QUERY_LANGUAGES,
  type QueryLanguage,
} from '../contracts/queryStructure.js';
import {
  SEARCHABLE_SYMBOL_KINDS,
  type SearchableSymbolKind,
} from '../contracts/searchSymbols.js';
import {
  SEE_CODEBASE_INTENTS,
  SEE_CODEBASE_MODES,
  type SeeCodebaseIntent,
  type SeeCodebaseMode,
  type SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import {
  collectQueryFlags,
  parseFormat,
  parsePositiveIntFlag,
} from './queryFlags.js';
import type { ParsedQueryCommand, QueryCommand } from './query.js';

export function parseQueryCommandTokens(tokens: readonly string[]): ParsedQueryCommand {
  if (tokens.length === 0) {
    return { kind: 'error', message: 'Missing query subcommand. Try `hoplon query --help`.' };
  }
  const [head, ...rest] = tokens;
  const flags = collectQueryFlags(rest);
  const format = parseFormat(flags.get('format'));
  if (format.kind === 'error') return format;

  if (head === 'capabilities') {
    return { kind: 'parsed', command: { kind: 'capabilities' }, format: format.value };
  }
  if (head === 'skeleton') {
    const files = flags.getAll('file');
    if (files.length === 0) {
      return { kind: 'error', message: '`query skeleton` requires at least one --file <path>.' };
    }
    return { kind: 'parsed', command: { kind: 'skeleton', files }, format: format.value };
  }
  if (head === 'structure') {
    return parseStructure(flags, format.value);
  }
  if (head === 'search') {
    return parseSearch(flags, format.value);
  }
  if (head === 'project') {
    return parseProject(flags, format.value);
  }
  if (head === 'see') {
    return parseSee(flags, format.value);
  }
  return { kind: 'error', message: `Unknown query subcommand: ${head}` };
}

function parseSee(
  flags: ReturnType<typeof collectQueryFlags>,
  format: 'json' | 'human',
): ParsedQueryCommand {
  const intentRaw = flags.get('intent');
  if (!intentRaw) {
    return {
      kind: 'error',
      message: `\`query see\` requires --intent <${SEE_CODEBASE_INTENTS.join('|')}>.`,
    };
  }
  if (!(SEE_CODEBASE_INTENTS as readonly string[]).includes(intentRaw)) {
    return {
      kind: 'error',
      message: `Unsupported --intent: ${intentRaw}. Supported: ${SEE_CODEBASE_INTENTS.join(', ')}`,
    };
  }
  const intent = intentRaw as SeeCodebaseIntent;

  const targets: SeeCodebaseTarget[] = [];
  for (const f of flags.getAll('target-file')) {
    targets.push({ kind: 'file', path: f });
  }
  for (const s of flags.getAll('target-symbol')) {
    const at = s.indexOf('@');
    if (at === -1) targets.push({ kind: 'symbol', name: s });
    else targets.push({ kind: 'symbol', name: s.slice(0, at), file: s.slice(at + 1) });
  }
  for (const p of flags.getAll('target-pattern')) {
    const at = p.indexOf('@');
    if (at === -1) targets.push({ kind: 'pattern', regex: p });
    else {
      const scopeRaw = p.slice(at + 1);
      const scope = scopeRaw.length > 0 ? scopeRaw.split(',').filter((s) => s.length > 0) : [];
      targets.push({
        kind: 'pattern',
        regex: p.slice(0, at),
        ...(scope.length > 0 ? { scope } : {}),
      });
    }
  }
  if (flags.get('target-project') === 'true') {
    targets.push({ kind: 'project' });
  }
  if (targets.length === 0) {
    return {
      kind: 'error',
      message:
        '`query see` requires at least one target: --target-file, --target-symbol, --target-pattern, or --target-project.',
    };
  }

  const modeRaw = flags.get('mode');
  let mode: SeeCodebaseMode | undefined;
  if (modeRaw !== undefined) {
    if (!(SEE_CODEBASE_MODES as readonly string[]).includes(modeRaw)) {
      return {
        kind: 'error',
        message: `Unsupported --mode: ${modeRaw}. Supported: ${SEE_CODEBASE_MODES.join(', ')}`,
      };
    }
    mode = modeRaw as SeeCodebaseMode;
  }

  const strict = flags.get('strict') === 'true';
  const includeProvenance = flags.get('no-provenance') === 'true' ? false : undefined;

  const maxBytes = parsePositiveIntFlag(flags.get('max-bytes'), 'max-bytes');
  if (maxBytes.kind === 'error') return maxBytes;
  const maxResults = parsePositiveIntFlag(flags.get('max-results'), 'max-results');
  if (maxResults.kind === 'error') return maxResults;

  return {
    kind: 'parsed',
    command: {
      kind: 'see',
      intent,
      targets,
      ...(mode !== undefined ? { mode } : {}),
      ...(strict ? { strict } : {}),
      ...(includeProvenance !== undefined ? { includeProvenance } : {}),
      ...(maxBytes.value !== undefined ? { maxBytes: maxBytes.value } : {}),
      ...(maxResults.value !== undefined ? { maxResults: maxResults.value } : {}),
    },
    format,
  };
}

function parseStructure(
  flags: ReturnType<typeof collectQueryFlags>,
  format: 'json' | 'human',
): ParsedQueryCommand {
  const files = flags.getAll('file');
  if (files.length === 0) {
    return { kind: 'error', message: '`query structure` requires at least one --file <path>.' };
  }
  const language = flags.get('language');
  if (!language) {
    return {
      kind: 'error',
      message: '`query structure` requires --language <js|ts|javascript|typescript|tsx>.',
    };
  }
  const normalisedLanguage = normaliseQueryLanguage(language);
  if (!normalisedLanguage) {
    return {
      kind: 'error',
      message: `Unsupported --language: ${language}. Supported: js, ts, ${SUPPORTED_QUERY_LANGUAGES.join(', ')}`,
    };
  }
  const pattern = flags.get('pattern');
  if (!pattern) {
    return { kind: 'error', message: '`query structure` requires --pattern <s-expression>.' };
  }
  const queryId = flags.get('query-id') ?? 'cli-query-structure';
  return {
    kind: 'parsed',
    command: { kind: 'structure', files, language: normalisedLanguage, pattern, queryId },
    format,
  };
}

function parseSearch(
  flags: ReturnType<typeof collectQueryFlags>,
  format: 'json' | 'human',
): ParsedQueryCommand {
  const namePattern = flags.get('pattern');
  if (!namePattern) {
    return { kind: 'error', message: '`query search` requires --pattern <regex>.' };
  }
  const rawKinds = flags.getAll('kind');
  const kinds: SearchableSymbolKind[] = [];
  for (const k of rawKinds) {
    if (!(SEARCHABLE_SYMBOL_KINDS as readonly string[]).includes(k)) {
      return {
        kind: 'error',
        message: `Unsupported --kind: ${k}. Supported: ${SEARCHABLE_SYMBOL_KINDS.join(', ')}`,
      };
    }
    kinds.push(k as SearchableSymbolKind);
  }
  const max = parsePositiveIntFlag(flags.get('max-results'), 'max-results');
  if (max.kind === 'error') return max;
  const files = flags.getAll('file');
  const cmd: QueryCommand = { kind: 'search', namePattern };
  if (files.length > 0) cmd.files = files;
  if (kinds.length > 0) cmd.kinds = kinds;
  if (max.value !== undefined) cmd.maxResults = max.value;
  return { kind: 'parsed', command: cmd, format };
}

function parseProject(
  flags: ReturnType<typeof collectQueryFlags>,
  format: 'json' | 'human',
): ParsedQueryCommand {
  const maxFiles = parsePositiveIntFlag(flags.get('max-files'), 'max-files');
  if (maxFiles.kind === 'error') return maxFiles;
  const samples = parsePositiveIntFlag(flags.get('sample-paths'), 'sample-paths');
  if (samples.kind === 'error') return samples;
  const cmd: QueryCommand = { kind: 'project' };
  if (maxFiles.value !== undefined) cmd.maxFiles = maxFiles.value;
  if (samples.value !== undefined) cmd.samplePathsPerLanguage = samples.value;
  return { kind: 'parsed', command: cmd, format };
}

function normaliseQueryLanguage(value: string): QueryLanguage | undefined {
  if (value === 'js') return 'javascript';
  if (value === 'ts') return 'typescript';
  if ((SUPPORTED_QUERY_LANGUAGES as readonly string[]).includes(value)) {
    return value as QueryLanguage;
  }
  return undefined;
}
