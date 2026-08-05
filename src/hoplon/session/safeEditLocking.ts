/**
 * session/safeEditLocking.ts — session-owned AST lock lifecycle (t-066).
 *
 * Packages the already-shipped sub-file AST lock basis (t-041) into the
 * supervised session write path. The session's `applyEdits` calls this
 * module to derive a bounded lock key set for the batch of proposed
 * changes, then acquires every key atomically in sorted order via
 * `lockAstRegionMulti` before any byte touches disk. Release happens in a
 * `finally` in the caller, even when the write path throws.
 *
 * Lock-key strategy:
 *
 *   - Structural (t-066) changes contribute node-scoped keys computed from
 *     the target's resolved byte range plus an overlap-aware cover of the
 *     other selectable structural nodes in the same file. Strict ancestor
 *     containers are excluded for nested targets so the node-key set itself
 *     remains honest about the selected subtree.
 *   - Structural files no longer contribute a whole-file key to the
 *     *pre-write* lock plan. Disjoint same-file structural sessions can
 *     therefore acquire disjoint node-key sets concurrently. The supervised
 *     write path still linearizes the final same-file structural commit on
 *     the existing per-file key later in `performApplyEdits` so each session
 *     re-resolves against the latest bytes before it writes.
 *   - Full-file and patch changes contribute one whole-file key per touched
 *     path. These variants are textual, not AST-node-scoped, so serializing
 *     them per file is the honest default: the prompt's "no whole-file
 *     serialization" guarantee is specifically about *node* edits.
 *   - When pre-lock structural resolution is unavailable (e.g. adapter
 *     missing, parse failed, file absent), we fall back to the whole-file
 *     key. The inside-lock apply path will still raise the correct typed
 *     `SessionError` before any write, so the caller sees consistent
 *     failure semantics; the fallback merely keeps concurrent writers
 *     serialized while the resolver reports the failure.
 *
 * This module is process-local because the shipped LockProvider contract
 * already is; swapping in a distributed provider (Redis Redlock) continues
 * to work through the same key-set API.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter, SyntaxTree } from '../adapters/codeIntelligence.js';
import type { LockProvider, Release } from '../adapters/lock.js';
import {
  astNodeLockKey,
  lockAstRegionMulti,
} from '../adapters/lockProvider/subFileAst.js';
import type { StructuralTarget, ProposedChange } from '../contracts/requests.js';
import {
  collectStructuralTargetMatches,
  isStrictStructuralPathAncestor,
  type StructuralTargetMatch,
} from '../util/structuralTargetTree.js';

export interface SafeEditLockKeyCounts {
  readonly nodeKeys: number;
  readonly fileKeys: number;
}

export interface ComputeSafeEditLockKeysResult {
  readonly keys: readonly string[];
  readonly counts: SafeEditLockKeyCounts;
}

export interface ComputeSafeEditLockKeysOptions {
  readonly proposedChanges: readonly ProposedChange[];
  readonly fs: HoplonFsAdapter;
  readonly codeIntelligence: CodeIntelligenceAdapter | null;
  readonly projectId: string;
}

export function fileLockKey(projectId: string, file: string): string {
  return `file:${projectId}:${file}`;
}

export async function computeSafeEditLockKeys(
  opts: ComputeSafeEditLockKeysOptions,
): Promise<ComputeSafeEditLockKeysResult> {
  const aggregate = new Set<string>();
  let nodeKeys = 0;
  let fileKeys = 0;

  const structuralByFile = new Map<string, ProposedChange[]>();
  const nonStructuralFiles = new Set<string>();

  for (const change of opts.proposedChanges) {
    if ('kind' in change && change.kind === 'structural') {
      const list = structuralByFile.get(change.file) ?? [];
      list.push(change);
      structuralByFile.set(change.file, list);
    } else {
      nonStructuralFiles.add(change.file);
    }
  }

  for (const file of nonStructuralFiles) {
    const key = fileLockKey(opts.projectId, file);
    if (!aggregate.has(key)) {
      aggregate.add(key);
      fileKeys += 1;
    }
  }

  for (const [file, changes] of structuralByFile) {
    const plan = await planStructuralFileLocks({
      file,
      changes,
      fs: opts.fs,
      codeIntelligence: opts.codeIntelligence,
      projectId: opts.projectId,
    });
    for (const key of plan.keys) {
      if (!aggregate.has(key)) {
        aggregate.add(key);
        if (key.startsWith('ast:')) {
          nodeKeys += 1;
        } else {
          fileKeys += 1;
        }
      }
    }
  }

  return {
    keys: Array.from(aggregate),
    counts: { nodeKeys, fileKeys },
  };
}

export async function acquireSafeEditLocks(
  lockProvider: LockProvider,
  keys: readonly string[],
): Promise<Release> {
  if (keys.length === 0) {
    return () => {};
  }
  return lockAstRegionMulti(lockProvider, [...keys]);
}

interface PlanStructuralFileLocksOptions {
  readonly file: string;
  readonly changes: readonly ProposedChange[];
  readonly fs: HoplonFsAdapter;
  readonly codeIntelligence: CodeIntelligenceAdapter | null;
  readonly projectId: string;
}

async function planStructuralFileLocks(
  opts: PlanStructuralFileLocksOptions,
): Promise<{ keys: readonly string[] }> {
  const stat = await opts.fs.stat(opts.file);
  const currentBytes = stat.exists ? await opts.fs.read(opts.file) : null;
  if (currentBytes === null || opts.codeIntelligence === null) {
    return { keys: [fileLockKey(opts.projectId, opts.file)] };
  }

  let tree: SyntaxTree;
  try {
    tree = await opts.codeIntelligence.parse(opts.file, currentBytes);
  } catch {
    return { keys: [fileLockKey(opts.projectId, opts.file)] };
  }

  const allNodes = collectStructuralTargetMatches(tree);
  const targets: StructuralTargetMatch[] = [];
  for (const change of opts.changes) {
    if (!('kind' in change) || change.kind !== 'structural') continue;
    const match = resolveLockTargetMatch(change.target, allNodes);
    if (match === null) {
      return { keys: [fileLockKey(opts.projectId, opts.file)] };
    }
    targets.push(match);
  }
  if (targets.length === 0) {
    return { keys: [fileLockKey(opts.projectId, opts.file)] };
  }
  return {
    keys: computeStructuralOverlapKeySet(opts.projectId, opts.file, targets, allNodes),
  };
}

function resolveLockTargetMatch(
  target: StructuralTarget,
  allNodes: readonly StructuralTargetMatch[],
): StructuralTargetMatch | null {
  const matches =
    'symbol' in target
      ? allNodes.filter(
          (node) => node.path.length === 1 && node.name === target.symbol,
        )
      : allNodes.filter(
          (node) =>
            node.path.length === target.symbolPath.length &&
            node.path.every((segment, index) => segment === target.symbolPath[index]),
        );
  return matches.length === 1 ? matches[0]! : null;
}

function computeStructuralOverlapKeySet(
  projectId: string,
  file: string,
  targets: readonly StructuralTargetMatch[],
  allNodes: readonly StructuralTargetMatch[],
): string[] {
  const keySet = new Set<string>();
  for (const target of targets) {
    for (const candidate of allNodes) {
      if (!byteRangesOverlap(target.byteRange, candidate.byteRange)) {
        continue;
      }
      if (isStrictStructuralPathAncestor(candidate.path, target.path)) {
        continue;
      }
      keySet.add(
        astNodeLockKey(projectId, file, {
          byteRange: candidate.byteRange,
          kind: candidate.kind,
        }),
      );
    }
  }
  return Array.from(keySet);
}

function byteRangesOverlap(
  left: [number, number],
  right: [number, number],
): boolean {
  return left[0] < right[1] && right[0] < left[1];
}
