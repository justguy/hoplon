import {
  SessionApplyEditsRequestSchema,
  SessionDryRunRequestSchema,
  SessionExtractRollbackTemplateRequestSchema,
  SessionMarkEditedRequestSchema,
  SessionRefSchema,
  SessionStageContentRequestSchema,
  StartSessionRequestSchema,
} from '../session/transportContracts.js';
import {
  handlerFor,
  toInputSchema,
  type SessionToolDefinition,
} from './sessionToolHelpers.js';
import type { SessionToolRegistryContext } from './sessionToolRegistryTypes.js';

export function buildSessionCoreTools({
  dispatcher,
  guardFor,
}: SessionToolRegistryContext): SessionToolDefinition[] {
  return [
    {
      name: 'start_edit_session',
      description:
        'Create a supervised Hoplon edit session from a WritableManifest and ' +
        'return its session id plus initial state. The returned sessionId is a ' +
        'handle for every subsequent session_* call.',
      inputSchema: toInputSchema(StartSessionRequestSchema),
      handler: handlerFor((args) => dispatcher.start(args), guardFor('start')),
    },
    {
      name: 'session_preflight',
      description:
        'Run Stage 1 preflight on the session. Advances state to ' +
        'preflighted_pass or preflighted_block. Legal only from state=created.',
      inputSchema: toInputSchema(SessionRefSchema),
      handler: handlerFor((args) => dispatcher.preflight(args), guardFor('preflight')),
    },
    {
      name: 'session_create_snapshot',
      description:
        'Capture the contracted writable scope as a snapshot. Legal only from ' +
        'state=preflighted_pass. Advances state to snapshotted.',
      inputSchema: toInputSchema(SessionRefSchema),
      handler: handlerFor(
        (args) => dispatcher.createSnapshot(args),
        guardFor('createSnapshot'),
      ),
    },
    {
      name: 'session_dry_run',
      description:
        'Evaluate proposedChanges in-memory against the contracted scope. ' +
        'Does not advance state; legal only from state=snapshotted.',
      inputSchema: toInputSchema(SessionDryRunRequestSchema),
      handler: handlerFor((args) => dispatcher.dryRun(args), guardFor('dryRun')),
    },
    {
      name: 'session_apply_edits',
      description:
        'Hoplon-applied write step (t-063): write each ProposedChange through ' +
        'the session\'s injected HoplonFsAdapter, derive changedFiles from the ' +
        'bytes actually written, and advance state to edited. Legal only from ' +
        'state=snapshotted; requires the server to have been constructed with ' +
        'an fs adapter. Returns {changedFiles, bytesWritten}.',
      inputSchema: toInputSchema(SessionApplyEditsRequestSchema),
      handler: handlerFor((args) => dispatcher.applyEdits(args), guardFor('applyEdits')),
    },
    {
      name: 'session_stage_content',
      description:
        'Append one chunk of a non-binary body to a session-scoped staging ' +
        'entry (t-076). Chunks must arrive in order (seq=0,1,2,...); the ' +
        'final chunk must carry expectedTotalSha256 + expectedTotalByteLength ' +
        'and the store rejects integrity/size mismatches with a typed ' +
        'SessionError. Does not advance state and never writes to disk — the ' +
        'finalized body is later consumed by session_apply_edits through a ' +
        'ProposedChange.stagedContent reference. Use this only when a single ' +
        'applyEdits request body would exceed the transport ceiling.',
      inputSchema: toInputSchema(SessionStageContentRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.stageContent(args),
        guardFor('stageContent'),
      ),
    },
    {
      name: 'session_mark_edited',
      description:
        'Host-owned compatibility declaration step: declare which files the ' +
        'host already wrote to disk. Advances state to edited. Prefer ' +
        'session_apply_edits when the server was launched with a Hoplon fs ' +
        'adapter; use session_mark_edited when writes happen outside Hoplon ' +
        '(e.g. IDE-owned editors, out-of-process tools).',
      inputSchema: toInputSchema(SessionMarkEditedRequestSchema),
      handler: handlerFor((args) => dispatcher.markEdited(args), guardFor('markEdited')),
    },
    {
      name: 'session_audit',
      description:
        'Audit the current tree against the contracted manifest. Advances state ' +
        'to audited_pass or audited_block. Legal only from state=edited.',
      inputSchema: toInputSchema(SessionRefSchema),
      handler: handlerFor((args) => dispatcher.audit(args), guardFor('audit')),
    },
    {
      name: 'session_revert',
      description:
        'Restore contracted files to the snapshotted state and delete ' +
        'uncontracted post-snapshot files (modulo the revert allowlist). ' +
        'Legal only from state=audited_block. Advances state to reverted.',
      inputSchema: toInputSchema(SessionRefSchema),
      handler: handlerFor((args) => dispatcher.revert(args), guardFor('revert')),
    },
    {
      name: 'session_extract_rollback_template',
      description:
        'Emit per-file rollback skeletons for the changedFiles (or the supplied ' +
        'files override). Legal only from state=reverted. Advances state to ' +
        'rollback_extracted.',
      inputSchema: toInputSchema(SessionExtractRollbackTemplateRequestSchema),
      handler: handlerFor(
        (args) => dispatcher.extractRollbackTemplate(args),
        guardFor('extractRollbackTemplate'),
      ),
    },
  ];
}
