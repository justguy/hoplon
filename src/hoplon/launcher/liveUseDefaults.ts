/**
 * launcher/liveUseDefaults.ts — `t-065` default-adoption truth handshake
 * plus the `t-075` code-only replacement boundary.
 *
 * This file exists separately from `status.ts` so the `t-065` contract (type
 * + canonical constant) has one owning file and `status.ts` stays under the
 * architecture 300-line cap.
 *
 * Scope discipline (read before editing):
 *   - adoption is claimed only on the Hoplon-packaged live-use bundle path
 *   - V2 two-layer remains `deferred` — `t-068` must ship first
 *   - host-owned fallbacks are narrowed, not removed: after `t-075` the raw
 *     companion is no longer load-bearing for supported non-binary code
 *     work, but it still covers non-code repo text (docs/configs/env/logs)
 *     and the launcher-unavailable operational case
 *   - this block is a truth handshake, not a runtime mechanism: no default
 *     is *selected* here at request time, the already-shipped `t-061`
 *     read/search surface (`engine.seeCodebase`) and `t-063` Hoplon-applied
 *     write path (`createHoplonEditSession.applyEdits`) are the runtime
 *     defaults on the bundle path
 */

/**
 * Default / fallback truth for the adopted live-use path (`t-065`).
 *
 *   - the adopted path named here is `hoplon-live-usage-bundle` — the
 *     packaged operator/agent surface. It is **not** a claim about the
 *     Phalanx pipeline's internal read surface; Phalanx handlers still
 *     read through host tooling on the hot path outside the
 *     `createHoplonEditSession` adoption from `t-058`.
 *   - the V2 two-layer operating model (`HOPLON_VISION_FINAL_V2.md` §8–9)
 *     is explicitly `deferred`. The substrate it needs — durable trace /
 *     provenance — is scheduled as `t-068` and is not materially landed.
 *   - fallbacks are host-owned on purpose; switching away from them
 *     without explicit user approval would be a silent default widening.
 */
import {
  HOPLON_CODE_READ_REPLACEMENT,
  type CodeReadReplacementBoundary,
} from './codeReadBoundary.js';
import {
  HOPLON_STRICT_AGENT_FALLBACK_POLICY,
  type StrictAgentFallbackPolicy,
} from '../transport/strictAgentFallback.js';

export {
  HOPLON_CODE_READ_REPLACEMENT,
  type CodeReadReplacementBoundary,
} from './codeReadBoundary.js';

export interface LiveUseDefaultsReport {
  /**
   * The adopted live-use path these defaults apply to. Hoplon does not
   * claim default adoption on paths that were not touched and proved —
   * benchmark evidence (`t-064`) covered the Hoplon-packaged bundle
   * surface, not the Phalanx pipeline's internal reads.
   */
  adoptedPath: 'hoplon-live-usage-bundle';
  /**
   * Primitives that default to Hoplon-owned surfaces on the adopted path.
   * Each field names a load-bearing engine/session entry point, not a
   * wrapper-derived label.
   */
  defaults: {
    agentRead: 'engine.seeCodebase';
    agentSearch: 'engine.seeCodebase';
    supervisedEdit: 'createHoplonEditSession.applyEdits';
  };
  /**
   * Explicit fallback categories. Host-owned on purpose; not a silent
   * escape hatch. Each entry names why the fallback is still the right
   * answer even after `t-064` / `t-075`.
   *
   * `scope` (added by `t-075`) names which boundary the fallback still
   * owns. After `t-075`, `raw_file_read` and `raw_text_search` are NOT
   * load-bearing on the supported non-binary code boundary; they remain
   * load-bearing for non-code repo text and the launcher-unavailable
   * operational case. See `codeReadReplacement` below for the boundary
   * the fallback no longer covers.
   */
  fallbacks: readonly {
    category:
      | 'raw_file_read'
      | 'raw_text_search'
      | 'structural_js_ts_read'
      | 'host_owned_editor_write';
    owner: 'host';
    primitive: string;
    /**
     * Narrow operational scope the fallback still owns. `t-075`
     * explicitly removes supported non-binary code work from the raw
     * fallback scopes.
     */
    scope:
      | 'non_code_repo_text_or_launcher_unavailable'
      | 'structural_small_file_ergonomics'
      | 'host_owned_editor';
    reason: string;
  }[];
  /**
   * `t-075` — the code-only replacement boundary over the packaged
   * read/search surface. Names the exact scope on which the host raw-text
   * / file companion is no longer load-bearing, names the single
   * authoritative packaged surface that replaces it, and keeps non-code
   * repo text explicitly outside the replacement claim.
   */
  codeReadReplacement: CodeReadReplacementBoundary;
  /**
   * Categories that are explicitly NOT covered by the adopted default and
   * that are tracked as separate follow-on work. Keeping this list honest
   * prevents the bundle from pretending to cover what it does not.
   */
  unsupported: readonly {
    category: string;
    trackedAs: string;
    reason: string;
  }[];
  /**
   * t-097 — strict-agent fallback posture. Compatibility fallbacks above
   * remain host/operator truth for the default profile, but strict agents get
   * a typed fail-closed result instead of host raw-tool recommendations.
   */
  strictAgentFallback: StrictAgentFallbackPolicy;
  /**
   * V2 operating-model stance on this branch. `deferred` means the
   * higher-order / state-machine / execution surface split has NOT been
   * adopted at runtime. Nothing in the shipped transport surface prevents
   * a higher-order caller from mutating state directly; adopting the
   * two-layer loop would require the `t-068` trace/provenance substrate
   * first.
   */
  operatingModel: {
    model: 'single-execution-surface';
    v2TwoLayer: 'deferred';
    deferredBecause: string;
    pendingOn: readonly ['t-068'];
  };
}

/**
 * The canonical `t-065` default-adoption handshake. Declared once so tests,
 * docs, and the status envelope all read the same truth.
 */
export const HOPLON_LIVE_USE_DEFAULTS: LiveUseDefaultsReport = {
  adoptedPath: 'hoplon-live-usage-bundle',
  defaults: {
    agentRead: 'engine.seeCodebase',
    agentSearch: 'engine.seeCodebase',
    supervisedEdit: 'createHoplonEditSession.applyEdits',
  },
  fallbacks: [
    {
      category: 'raw_file_read',
      owner: 'host',
      primitive: 'cat / IDE viewer / filesystem MCP tool',
      scope: 'non_code_repo_text_or_launcher_unavailable',
      reason:
        'engine.seeCodebase is authoritative for supported non-binary code reads after t-075; host tooling remains correct only for non-code repo text (docs/configs/env/logs/binary) or when the launcher is not running',
    },
    {
      category: 'raw_text_search',
      owner: 'host',
      primitive: 'rg / grep',
      scope: 'non_code_repo_text_or_launcher_unavailable',
      reason:
        'engine.seeCodebase is authoritative for supported non-binary code raw text search after t-075; host ripgrep/grep remain correct only for non-code repo text or pipelines that cannot depend on a running launcher',
    },
    {
      category: 'structural_js_ts_read',
      owner: 'host',
      primitive: 'direct file read of small JS/TS files',
      scope: 'structural_small_file_ergonomics',
      reason:
        'the t-064 live T1 result showed direct reads are ergonomically simpler when the task asks for exact line ranges; Hoplon structural reads remain preferred but host reads are an honest ergonomic fallback',
    },
    {
      category: 'host_owned_editor_write',
      owner: 'host',
      primitive: 'createHoplonEditSession.markEdited',
      scope: 'host_owned_editor',
      reason:
        'the session still accepts host-written bytes via markEdited for IDE-owned editors or out-of-process tools; applyEdits is the default only when a filesystem adapter is injected',
    },
  ] as const,
  codeReadReplacement: HOPLON_CODE_READ_REPLACEMENT,
  unsupported: [
    {
      category: 'node_scoped_safe_edit',
      trackedAs: 't-066',
      reason:
        'sub-file AST-locked edits are not yet exposed as a packaged session mode',
    },
    {
      category: 'behavior_verification',
      trackedAs: 't-067',
      reason:
        'host-owned sandboxed test execution and packaging of runtime-failure context is not shipped',
    },
    {
      category: 'durable_execution_trace',
      trackedAs: 't-068',
      reason:
        'execution trace / attempt / proof-bundle substrate with provenance categories is not shipped; the packaged session registry is transport-local',
    },
    {
      category: 'phalanx_pipeline_internal_reads',
      trackedAs: 'out-of-scope-for-t-065',
      reason:
        't-064 benchmark ran on Hoplon-packaged temp workspaces; the Phalanx pipeline handlers still read through host tooling on the hot path and were not flipped in this slice',
    },
  ] as const,
  strictAgentFallback: HOPLON_STRICT_AGENT_FALLBACK_POLICY,
  operatingModel: {
    model: 'single-execution-surface',
    v2TwoLayer: 'deferred',
    deferredBecause:
      'V2 two-layer loop requires durable trace/provenance that distinguishes Hoplon facts from higher-order recommendations, state-machine decisions, and wrapper metadata; that substrate is tracked as t-068 and is not materially landed on this branch',
    pendingOn: ['t-068'] as const,
  },
};
