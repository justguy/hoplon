/** Stable launcher advertisement for the supervised quick-edit wrapper. */

/**
 * Operator-facing advertisement for the t-079 single-shot quick-edit
 * wrapper. The wrapper composes the shipped supervised session loop
 * (preflight → createSnapshot → applyEdits | markEdited → audit → [revert →
 * extractRollbackTemplate on audit BLOCK] → close) into one call without
 * introducing a second write mechanism. This const is the stable launcher
 * handshake so docs, tests, and any future `hoplon status --verbose` surface
 * read one canonical shape.
 *
 * Intentionally NOT threaded through `LauncherStatusReport.safeEdit` so the
 * existing status-report equality assertions stay untouched; consumers that
 * need the advertisement import this const directly.
 */
export interface HoplonQuickEditAdvertisement {
  readonly taskId: 't-079';
  /** In-process entry — `quickEdit` exported from the session barrel. */
  readonly inProcessEntry: 'createHoplonEditSession + quickEdit';
  /** Packaged MCP tool. */
  readonly mcpTool: 'session_quick_edit';
  /** Packaged HTTP route. */
  readonly httpRoute: 'POST /session/quickEdit';
  /** Typed HTTP client method. */
  readonly httpClientMethod: 'createRemoteHoplonSessionClient().quickEdit';
  /** The shipped write path the wrapper composes; never a second mechanism. */
  readonly underlyingWritePath: 'session.applyEdits | session.markEdited';
}

export const HOPLON_QUICK_EDIT_ADVERTISEMENT: HoplonQuickEditAdvertisement = {
  taskId: 't-079',
  inProcessEntry: 'createHoplonEditSession + quickEdit',
  mcpTool: 'session_quick_edit',
  httpRoute: 'POST /session/quickEdit',
  httpClientMethod: 'createRemoteHoplonSessionClient().quickEdit',
  underlyingWritePath: 'session.applyEdits | session.markEdited',
};
