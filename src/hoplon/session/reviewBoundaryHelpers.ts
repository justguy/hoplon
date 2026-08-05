/** Pure helpers used by logical review-boundary resolution. */

import type { CodeIntelligenceAdapter, Symbol as CiSymbol, SyntaxTree } from '../adapters/codeIntelligence.js';
import { AdapterError } from '../contracts/errors.js';
import type {
  ReviewBoundary,
  ReviewBoundaryChangeMode,
  ReviewFileFallback,
  ReviewFileFallbackReason,
} from '../contracts/reviewPayload.js';
import { renderUnifiedDiff } from './unifiedDiff.js';

export function buildFallback(args: {
  reason: ReviewFileFallbackReason;
  message: string;
  before: string;
  after: string;
  path: string;
  contextLines: number;
}): ReviewFileFallback {
  const unifiedDiff = renderUnifiedDiff(args.before, args.after, {
    aLabel: args.path,
    bLabel: args.path,
    contextLines: args.contextLines,
  });
  return { reason: args.reason, message: args.message, unifiedDiff };
}

interface BuildBoundaryArgs {
  symbol: CiSymbol | null;
  side: 'before' | 'after';
  changeMode: ReviewBoundaryChangeMode;
  before: string;
  after: string;
  beforeText?: string;
  afterText: string;
  contextLines: number;
}

export function buildBoundary(args: BuildBoundaryArgs): ReviewBoundary {
  const { symbol, side, changeMode, before, after, afterText, beforeText } = args;
  const referenceText =
    side === 'after' ? afterText : (beforeText ?? afterText);
  const referenceBytes = symbol ? symbol.byteRange : ([0, 0] as [number, number]);
  const lineRange = computeLineRange(referenceText, referenceBytes);
  const unifiedDiff = renderUnifiedDiff(before, after, {
    aLabel: symbol?.name ?? 'file',
    bLabel: symbol?.name ?? 'file',
    contextLines: args.contextLines,
    includeHeader: false,
  });
  return {
    symbol: symbol?.name ?? null,
    symbolKind: symbol?.kind ?? null,
    side,
    byteRange: referenceBytes,
    lineRange,
    changeMode,
    unifiedDiff,
  };
}

export async function parseTopLevelSymbols(
  ci: CodeIntelligenceAdapter,
  path: string,
  bytes: Uint8Array,
  signal?: AbortSignal | undefined,
): Promise<CiSymbol[]> {
  const tree: SyntaxTree = await ci.parse(path, bytes, signal);
  return ci.getTopLevelSymbols(tree);
}

export function groupByName(symbols: readonly CiSymbol[]): Map<string, CiSymbol[]> {
  const out = new Map<string, CiSymbol[]>();
  for (const sym of symbols) {
    const existing = out.get(sym.name);
    if (existing) {
      existing.push(sym);
    } else {
      out.set(sym.name, [sym]);
    }
  }
  return out;
}

export function collectTouchedSymbolNames(
  beforeByName: Map<string, CiSymbol[]>,
  afterByName: Map<string, CiSymbol[]>,
  before: Uint8Array,
  after: Uint8Array,
): string[] {
  const names = new Set<string>();
  for (const name of beforeByName.keys()) names.add(name);
  for (const name of afterByName.keys()) names.add(name);

  const touched: string[] = [];
  for (const name of names) {
    const beforeMatches = beforeByName.get(name) ?? [];
    const afterMatches = afterByName.get(name) ?? [];
    if (beforeMatches.length !== afterMatches.length) {
      touched.push(name);
      continue;
    }
    let changed = false;
    const count = beforeMatches.length;
    for (let idx = 0; idx < count; idx += 1) {
      const b = beforeMatches[idx]!;
      const a = afterMatches[idx]!;
      const bSlice = sliceBytesAsText(before, b.byteRange);
      const aSlice = sliceBytesAsText(after, a.byteRange);
      if (bSlice !== aSlice) {
        changed = true;
        break;
      }
    }
    if (changed) touched.push(name);
  }
  // Stable order: by first occurrence in after then before
  const order = new Map<string, number>();
  let next = 0;
  for (const sym of afterByName.keys()) {
    if (!order.has(sym)) order.set(sym, next++);
  }
  for (const sym of beforeByName.keys()) {
    if (!order.has(sym)) order.set(sym, next++);
  }
  touched.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  return touched;
}

export function classifyPair(
  before: CiSymbol | null,
  after: CiSymbol | null,
): {
  changeMode: ReviewBoundaryChangeMode;
  side: 'before' | 'after';
  symbol: CiSymbol | null;
} {
  if (before !== null && after !== null) {
    return { changeMode: 'modified', side: 'after', symbol: after };
  }
  if (after !== null) {
    return { changeMode: 'added', side: 'after', symbol: after };
  }
  if (before !== null) {
    return { changeMode: 'removed', side: 'before', symbol: before };
  }
  return { changeMode: 'modified', side: 'after', symbol: null };
}

export function sliceBytesAsText(
  bytes: Uint8Array,
  range: readonly [number, number],
): string {
  const [start, end] = range;
  const safeStart = Math.max(0, Math.min(start, bytes.byteLength));
  const safeEnd = Math.max(safeStart, Math.min(end, bytes.byteLength));
  const slice = bytes.subarray(safeStart, safeEnd);
  return new TextDecoder('utf-8', { fatal: false }).decode(slice);
}

export function decodeOrNull(bytes: Uint8Array | null): string | null {
  if (bytes === null) return null;
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
}

function computeLineRange(
  text: string,
  byteRange: readonly [number, number],
): [number, number] {
  const [startByte, endByte] = byteRange;
  const encoder = new TextEncoder();
  const bytes = encoder.encode(text);
  const prefixStart = bytes.subarray(0, Math.min(startByte, bytes.byteLength));
  const prefixEnd = bytes.subarray(0, Math.min(endByte, bytes.byteLength));
  const startLine = countLines(prefixStart) + 1;
  const endLine = Math.max(startLine, countLines(prefixEnd) + 1);
  return [startLine, endLine];
}

function countLines(bytes: Uint8Array): number {
  let count = 0;
  for (let idx = 0; idx < bytes.byteLength; idx += 1) {
    if (bytes[idx] === 0x0a) count += 1;
  }
  return count;
}

export function isCoveredLanguage(path: string): boolean {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return false;
  const ext = path.slice(dot).toLowerCase();
  return (
    ext === '.js' ||
    ext === '.mjs' ||
    ext === '.cjs' ||
    ext === '.jsx' ||
    ext === '.ts' ||
    ext === '.tsx'
  );
}

export function reasonForParseFailure(err: unknown): ReviewFileFallbackReason {
  if (err instanceof AdapterError && err.kind === 'parser_init_failed') {
    return 'parse_failure';
  }
  return 'parse_failure';
}

export function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}
