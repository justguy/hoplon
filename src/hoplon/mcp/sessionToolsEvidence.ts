import type { SessionRegistry } from '../session/registry.js';
import {
  SessionGetCloseoutProofBundleRequestSchema,
  SessionGetRepairContextRequestSchema,
  SessionGetReviewPayloadRequestSchema,
  SessionQuickEditRequestSchema,
  SessionRefSchema,
  SessionTargetFirstScopedEditRequestSchema,
  SessionVerifyBehaviorRequestSchema,
} from '../session/transportContracts.js';
import type { StrictEngagementGateDeps } from '../transport/strictEngagementGate.js';
import {
  StrictSessionListRequestSchema,
  strictScopedSessionList,
} from '../transport/strictSessionList.js';
import {
  errResult,
  handlerFor,
  okResult,
  toInputSchema,
  type SessionToolDefinition,
} from './sessionToolHelpers.js';
import type { SessionToolRegistryContext } from './sessionToolRegistryTypes.js';

interface SessionEvidenceToolContext extends SessionToolRegistryContext {
  registry: SessionRegistry;
  strictEngagementGate?: StrictEngagementGateDeps;
}

export function buildSessionEvidenceTools({
  dispatcher,
  guardFor,
  registry,
  strictEngagementGate,
}: SessionEvidenceToolContext): SessionToolDefinition[] {
  return [
    {
      name: 'session_get_repair_context',
      description:
        'Package the failed-audit session into a reusable host-facing ' +
        'RepairContext (t-070): AuditResult + RollbackTemplate + session ' +
        'history + attempt bookkeeping. Legal only after audit() returned ' +
        'BLOCK AND extractRollbackTemplate has run. Does not advance state. ' +
        'Optional `includeDependencyImpact` (t-077) opts into the advisory ' +
        'dependency-impact sidecar over manifest scope + failed-audit ' +
        'violations; defaults to UNAVAILABLE when not requested.',
      inputSchema: toInputSchema(SessionGetRepairContextRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.getRepairContext(args),
        guardFor('getRepairContext'),
      ),
    },
    {
      name: 'session_get_closeout_proof_bundle',
      description:
        'Package a closeout proof bundle from the current session facts: ' +
        'snapshot/ref metadata, changed files, transition count, audit status, ' +
        'and optional review / behavior evidence. Read-only; does not advance state.',
      inputSchema: toInputSchema(SessionGetCloseoutProofBundleRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.getCloseoutProofBundle(args),
        guardFor('getCloseoutProofBundle'),
      ),
    },
    {
      name: 'session_review',
      description:
        'Package a focused review payload (t-072) for the session. Returns ' +
        'touched files with logical-boundary-bounded unified diffs, ' +
        'changedFiles / changeKindCounts sidecars, and optional advisory ' +
        'dependency-impact / relevant-tests panes (opt in via ' +
        'includeDependencyImpact / includeRelevantTests — t-077 canonicalizes ' +
        'the former blast-radius pane). Phase defaults to post-edit; pass ' +
        'phase=preview with proposedChanges to review before applying.',
      inputSchema: toInputSchema(SessionGetReviewPayloadRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.getReviewPayload(args),
        guardFor('review'),
      ),
    },
    {
      name: 'session_verify_behavior',
      description:
        'Package a host-facing behavior verification result (t-067). Picks ' +
        'tests via the shipped getRelevantTests static oracle over the ' +
        "session's changedFiles (override with testsOverride), invokes the " +
        'host-injected BehaviorTestRunnerAdapter, and wraps the outcome as an ' +
        'advisory VerifyBehaviorResult with linkage back to the session/' +
        'snapshot. Test execution stays host-owned; Hoplon never spawns test ' +
        'processes. When no runner is wired, returns status:UNAVAILABLE / ' +
        'outcome:NOT_RUN / unavailabilityReason:no_runner instead of ' +
        'fabricating a pass. Does not advance state; advisory only.',
      inputSchema: toInputSchema(SessionVerifyBehaviorRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.verifyBehavior(args),
        guardFor('verifyBehavior'),
      ),
    },
    {
      name: 'session_inspect',
      description:
        'Return the full SessionSnapshot (state + manifest + history + last ' +
        'results). Read-only; does not advance state.',
      inputSchema: toInputSchema(SessionRefSchema),
      handler: handlerFor((args) => dispatcher.inspect(args), guardFor('inspect')),
    },
    {
      name: 'session_close',
      description:
        'Close the session and evict it from the transport registry. Idempotent ' +
        'on session.state; safe to call from any non-closed state.',
      inputSchema: toInputSchema(SessionRefSchema),
      handler: handlerFor((args) => dispatcher.close(args), guardFor('close')),
    },
    strictEngagementGate !== undefined
      ? {
          name: 'session_list',
          description:
            'List the live sessions owned by the presented engagement ' +
            '(hcr-004: strict listing is scoped to the caller — pass ' +
            'projectId plus the engagement context from projects_handshake). ' +
            'Inspection only; no state mutation.',
          inputSchema: toInputSchema(StrictSessionListRequestSchema),
          handler: async (args: Record<string, unknown>) => {
            try {
              return okResult(
                await strictScopedSessionList({
                  gate: strictEngagementGate,
                  registry,
                  rawBody: args,
                }),
              );
            } catch (err) {
              return errResult(err, args);
            }
          },
        }
      : {
          name: 'session_list',
          description:
            'List the live sessions tracked by the transport registry. Inspection ' +
            'only; no state mutation.',
          inputSchema: { type: 'object', properties: {} },
          handler: async () => {
            try {
              return okResult(dispatcher.list());
            } catch (err) {
              return errResult(err);
            }
          },
        },
    {
      name: 'session_quick_edit',
      description:
        'Single-shot supervised quick-edit wrapper (t-079): run the full ' +
        'ordered edit loop (preflight → createSnapshot → applyEdits | ' +
        'markEdited → audit → [revert → extractRollbackTemplate on audit ' +
        'BLOCK] → close) in one call. Composes `createHoplonEditSession` ' +
        'and the shipped supervised write path; does NOT introduce a ' +
        'second write mechanism. Returns a discriminated-union result keyed ' +
        'by `outcome` (pass / block / failed) and, on failure, the specific ' +
        '`phase` that failed plus the session + snapshot artifact refs so ' +
        'review and audit evidence remain reachable. Use this only for ' +
        'bounded trivial edits — long-running or multi-stage flows should ' +
        'still drive the per-phase session tools directly.',
      inputSchema: toInputSchema(SessionQuickEditRequestSchema),
      handler: handlerFor((args) => dispatcher.quickEdit(args), guardFor('quickEdit')),
    },
    {
      name: 'session_target_first_scoped_edit',
      description:
        'Draft or run a target-first scoped edit over the existing supervised ' +
        'session path. Preview mode returns a non-authoritative manifest draft, ' +
        'optional exact edit slice, and proof plan without writing. Apply mode ' +
        'requires an acceptedManifest and delegates to session_quick_edit.',
      inputSchema: toInputSchema(SessionTargetFirstScopedEditRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.targetFirstScopedEdit(args),
        guardFor('targetFirstScopedEdit'),
      ),
    },
  ];
}
