/**
 * engine/types.ts — HoplonEngine interface, HoplonAdapters, HoplonEngineConfig.
 *
 * All public methods return Promise<T> (invariant H3 — no callbacks, no event emitters).
 * Every async method accepts an optional AbortSignal (H12).
 * The engine never owns retry or escalation policy (invariant H4).
 *
 * EXCEPTIONS (synchronous methods):
 *   compressRetryContext — pure data transform over AuditViolation arrays (recs §15.9, LC9).
 *   computeMinimalPatch  — pure byte-range arithmetic over violation data (recs §15.5, LC5).
 * Both are no-I/O, no-async functions that return values directly (not Promises).
 */

import type { DlpPolicyMode } from '../contracts/dlp.js';

// ---------------------------------------------------------------------------

// HoplonEngineConfig — per-deployment tuning (not adapter-specific)
// ---------------------------------------------------------------------------

/**
 * Configuration for the HoplonEngine.
 * Per-capability tuning (SQLite WAL, tree-sitter grammar paths, etc.)
 * lives in the adapter factory's options, not here.
 *
 * ## fsRoot decision (E1)
 * fsRoot is required here (no default) because operations (packContext, createSnapshot,
 * auditDiff, revertUncontracted) all need it for canonicalizePath (H9) and copy-staging
 * (D1/D2). The HoplonFsAdapter does not expose a getRoot() method — the root is an
 * adapter-internal concern. Adding fsRoot to HoplonEngineConfig is the cleanest solution:
 * it makes the root explicit at factory construction and avoids modifying the C2 adapter
 * contract. For createDefaultHoplonEngine, fsRoot=opts.root (the project directory).
 *
 * Reviewer note: this is an additive change to the A3.1 spec. ARCHITECTURE.md should
 * be updated to reflect that HoplonEngineConfig includes fsRoot.
 */
export interface HoplonEngineConfigDefinition {
  /** Default: 'local-0'. Non-empty ASCII, no whitespace. Frozen at construction (H5). */
  engineId?: string;
  /**
   * The trusted filesystem root for all path operations (H9).
   * All manifest and file paths are canonicalized relative to this root.
   * Required for any engine method that performs file I/O.
   * Default: process.cwd() (current working directory at engine construction).
   *
   * For tests: pass '/' (memfs operates under '/').
   * For production: pass the project root directory.
   */
  fsRoot?: string;
  /** Path to the Hoplon-internal git repo. Default: '.hoplon/repo'. */
  gitRepoDir?: string;
  /**
   * Glob patterns matching files that revertUncontracted must NEVER touch.
   * Default: ['.git/**', 'node_modules/**', '.hoplon/**']
   */
  revertAllowlist?: string[];
  /**
   * Per-file size cap for packContext and auditDiff. Default: 524288 (512 KB).
   * Breached files surface in failures/violations, never crash the engine (H15).
   */
  maxFileBytes?: number;
  /**
   * tree-sitter parse timeout per file in ms. Default: 5000.
   * Timed-out files surface in failures/violations (H15).
   */
  parseTimeoutMs?: number;
  /**
   * Override the built-in secret regex patterns for createSnapshot scanning.
   * Default: built-in set (AWS keys, GitHub PATs, private-key PEM headers).
   */
  secretPatterns?: RegExp[];
  /**
   * Whether to store the manifest inline or hash-only.
   * Default: 'inline' (Phase 1 ships inline only).
   * 'hash_only' is a Phase 4 privacy mode.
   */
  manifestStorageMode?: 'inline' | 'hash_only';
  /**
   * TTL retention for new snapshots in milliseconds.
   * Default: 2592000000 (30 days). Set to 0 to keep snapshots forever (ttlExpires = null).
   * W3: createSnapshot populates ttl_expires from this value at write time.
   */
  ttlRetentionMs?: number;
  /**
   * DS1 — H23: The stable identifier for this engine node in a distributed deployment.
   *
   * Phase 1/2 single-node deployments: this field is optional and ignored by the
   * engine core. Passing it is safe (pass-through).
   *
   * Phase 3 distributed deployments: this field is required when the engine
   * uses a distributed SnapshotStore (e.g., PG1). The value is propagated to
   * `setReplicaIds` calls so that each node stamps its own ID into `replica_ids`
   * after committing a snapshot.
   *
   * Zod-enforced: non-empty string if present. No whitespace constraint beyond
   * that enforced at the Zod level (callers use stable node identifiers such as
   * hostname, pod name, or UUID).
   *
   * Invariant H23: `replica_ids` is the only distributed-state surface; Phase 1/2
   * adapters may leave it empty.
   */
  replicaId?: string;
  /**
   * t-026 — semantic-DLP policy stance applied during createSnapshot.
   *
   * - `'disabled'` — DLP adapter is never invoked.
   * - `'warn'` — findings surface as `possible_dlp_finding` warnings (default).
   * - `'block'` — any finding causes createSnapshot to throw
   *   `ValidationError({kind: 'dlp_policy_block'})` before Phase B git commit.
   *
   * Default when omitted: `'warn'`. Never the implicit `'block'`.
   */
  dlpPolicyMode?: DlpPolicyMode;
}

// ---------------------------------------------------------------------------
