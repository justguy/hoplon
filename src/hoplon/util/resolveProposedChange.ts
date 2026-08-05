import type {
  FullFileProposedChange,
  PatchProposedChange,
  ProposedChange,
  StructuralProposedChange,
  StructuralTarget,
} from '../contracts/requests.js';
import type {
  CodeIntelligenceAdapter,
  Symbol,
} from '../adapters/codeIntelligence.js';
import { resolveSymbolPathMatches } from './structuralTargetTree.js';

export type ProposedChangeKind = 'full_file' | 'patch' | 'structural';

export type ProposedChangeResolutionErrorKind =
  | 'missing_code_intelligence'
  | 'patch_not_applicable'
  | 'target_not_resolved';

export interface ProposedChangeResolutionErrorDetails {
  readonly file: string;
  readonly changeKind: ProposedChangeKind;
  readonly failedHunkIndex?: number;
  readonly requestedSymbol?: string;
}

export interface ResolveProposedChangeContext {
  currentBytes: Uint8Array | null;
  codeIntelligence: CodeIntelligenceAdapter | null;
  signal?: AbortSignal | undefined;
}

/**
 * Describe a structural target's human-readable identity for error messages
 * and lock-key derivation. `{ symbol }` → `"symbol"`. `{ symbolPath: [...] }`
 * → `"a.b.c"` joined with `.`.
 */
export function describeStructuralTarget(target: StructuralTarget): string {
  if ('symbol' in target) return target.symbol;
  return target.symbolPath.join('.');
}

export interface ResolvedProposedChange {
  file: string;
  bytes: Uint8Array;
  kind: ProposedChangeKind;
}

export class ProposedChangeResolutionError extends Error {
  readonly kind: ProposedChangeResolutionErrorKind;
  readonly detail: string;
  readonly details: ProposedChangeResolutionErrorDetails;

  constructor(
    kind: ProposedChangeResolutionErrorKind,
    detail: string,
    details: ProposedChangeResolutionErrorDetails,
  ) {
    super(detail);
    this.name = 'ProposedChangeResolutionError';
    this.kind = kind;
    this.detail = detail;
    this.details = details;
  }
}

export function inferProposedChangeKind(change: ProposedChange): ProposedChangeKind {
  if ('kind' in change && change.kind === 'patch') return 'patch';
  if ('kind' in change && change.kind === 'structural') return 'structural';
  return 'full_file';
}

export async function resolveProposedChange(
  change: ProposedChange,
  ctx: ResolveProposedChangeContext,
): Promise<ResolvedProposedChange> {
  const kind = inferProposedChangeKind(change);
  const encoder = new TextEncoder();
  if (kind === 'full_file') {
    const fullFile = change as FullFileProposedChange;
    return { file: fullFile.file, bytes: encoder.encode(fullFile.content), kind };
  }
  if (kind === 'patch') {
    const patch = change as PatchProposedChange;
    return { file: patch.file, bytes: applyPatchHunks(patch, ctx), kind };
  }
  const structural = change as StructuralProposedChange;
  return {
    file: structural.file,
    bytes: await applyStructuralReplace(structural, ctx),
    kind,
  };
}

function currentAsString(ctx: ResolveProposedChangeContext, file: string, op: string): string {
  if (ctx.currentBytes === null) {
    throw new ProposedChangeResolutionError(
      'patch_not_applicable',
      `${op} on "${file}" requires the file to already exist`,
      {
        file,
        changeKind: 'patch',
      },
    );
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(ctx.currentBytes);
}

function applyPatchHunks(
  change: PatchProposedChange,
  ctx: ResolveProposedChangeContext,
): Uint8Array {
  let current = currentAsString(ctx, change.file, 'patch');
  for (let i = 0; i < change.hunks.length; i += 1) {
    const hunk = change.hunks[i]!;
    const first = current.indexOf(hunk.search);
    if (first === -1) {
      throw new ProposedChangeResolutionError(
        'patch_not_applicable',
        `patch hunk ${i} for "${change.file}": search anchor not found`,
        {
          file: change.file,
          changeKind: 'patch',
          failedHunkIndex: i,
        },
      );
    }
    const second = current.indexOf(hunk.search, first + 1);
    if (second !== -1) {
      throw new ProposedChangeResolutionError(
        'patch_not_applicable',
        `patch hunk ${i} for "${change.file}": search anchor matched more than once (anchors must be unique)`,
        {
          file: change.file,
          changeKind: 'patch',
          failedHunkIndex: i,
        },
      );
    }
    current =
      current.slice(0, first) + hunk.replace + current.slice(first + hunk.search.length);
  }
  return new TextEncoder().encode(current);
}

async function applyStructuralReplace(
  change: StructuralProposedChange,
  ctx: ResolveProposedChangeContext,
): Promise<Uint8Array> {
  const match = await resolveStructuralTargetMatch(change.file, change.target, ctx);
  const [start, end] = match.byteRange;
  const head = ctx.currentBytes!.subarray(0, start);
  const tail = ctx.currentBytes!.subarray(end);
  const replacement = new TextEncoder().encode(change.content);
  const out = new Uint8Array(head.byteLength + replacement.byteLength + tail.byteLength);
  out.set(head, 0);
  out.set(replacement, head.byteLength);
  out.set(tail, head.byteLength + replacement.byteLength);
  return out;
}

/**
 * Resolve a structural target to exactly one AST node match in the current
 * file bytes. Handles both shipped selector shapes:
 *
 *   - `{ symbol }` — single top-level symbol (t-071 default).
 *   - `{ symbolPath }` — nested descent through named children (t-066).
 *
 * Throws `ProposedChangeResolutionError` when the adapter is missing, the
 * file does not yet exist, or the target resolves to zero or multiple
 * matches. Keeps exact byte-offset derivation Hoplon-owned — the caller
 * never supplies byte ranges.
 */
export async function resolveStructuralTargetMatch(
  file: string,
  target: StructuralTarget,
  ctx: ResolveProposedChangeContext,
): Promise<Symbol> {
  const identity = describeStructuralTarget(target);
  if (!ctx.codeIntelligence) {
    throw new ProposedChangeResolutionError(
      'missing_code_intelligence',
      'structural ProposedChange requires a codeIntelligence adapter',
      {
        file,
        changeKind: 'structural',
        requestedSymbol: identity,
      },
    );
  }
  if (ctx.currentBytes === null) {
    throw new ProposedChangeResolutionError(
      'target_not_resolved',
      `structural replace on "${file}" requires the file to already exist`,
      {
        file,
        changeKind: 'structural',
        requestedSymbol: identity,
      },
    );
  }
  const tree = await ctx.codeIntelligence.parse(file, ctx.currentBytes, ctx.signal);
  const matches =
    'symbol' in target
      ? ctx.codeIntelligence
          .getTopLevelSymbols(tree)
          .filter((s: Symbol) => s.name === target.symbol)
      : resolveSymbolPathMatches(tree, target.symbolPath);
  if (matches.length === 0) {
    throw new ProposedChangeResolutionError(
      'target_not_resolved',
      'symbol' in target
        ? `structural target "${identity}" not found as a top-level symbol in "${file}"`
        : `structural target path [${target.symbolPath.join(', ')}] not found in "${file}"`,
      {
        file,
        changeKind: 'structural',
        requestedSymbol: identity,
      },
    );
  }
  if (matches.length > 1) {
    throw new ProposedChangeResolutionError(
      'target_not_resolved',
      `structural target "${identity}" matched ${matches.length} nodes in "${file}"; target must be unique`,
      {
        file,
        changeKind: 'structural',
        requestedSymbol: identity,
      },
    );
  }
  return matches[0]!;
}
