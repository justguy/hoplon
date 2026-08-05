import type { SessionRegistry } from './registry.js';
import {
  SessionQuickEditRequestSchema,
  SessionTargetFirstScopedEditRequestSchema,
} from './transportContracts.js';
import type { SessionTransportDispatcher } from './transportDispatcherTypes.js';
import { encodeQuickEditResultForTransport } from './transportQuickEditResult.js';
import { parseOrThrow, wrap } from './transportSupport.js';

export function createSessionConvenienceHandlers(
  registry: SessionRegistry,
): Pick<
  SessionTransportDispatcher,
  'quickEdit' | 'targetFirstScopedEdit'
> {
  return {
    async quickEdit(rawBody) {
      const parsed = parseOrThrow(SessionQuickEditRequestSchema, rawBody, 'quickEdit');
      const wrapperOpts: Parameters<typeof registry.quickEdit>[0] = {
        manifest: parsed.manifest,
      };
      if (parsed.correlationId !== undefined) {
        wrapperOpts.correlationId = parsed.correlationId;
      }
      if (parsed.sessionId !== undefined) {
        wrapperOpts.sessionId = parsed.sessionId;
      }
      if (parsed.priorRepairContext !== undefined) {
        wrapperOpts.priorRepairContext = parsed.priorRepairContext;
      }
      if (parsed.editMode !== undefined) wrapperOpts.editMode = parsed.editMode;
      if (parsed.proposedChanges !== undefined) {
        wrapperOpts.proposedChanges = parsed.proposedChanges;
      }
      if (parsed.markEditedFiles !== undefined) {
        wrapperOpts.markEditedFiles = parsed.markEditedFiles;
      }
      if (parsed.revertOnBlock !== undefined) {
        wrapperOpts.revertOnBlock = parsed.revertOnBlock;
      }
      if (parsed.extractRollbackTemplateOnBlock !== undefined) {
        wrapperOpts.extractRollbackTemplateOnBlock =
          parsed.extractRollbackTemplateOnBlock;
      }
      const result = await registry.quickEdit(wrapperOpts);
      return encodeQuickEditResultForTransport(result);
    },

    async targetFirstScopedEdit(rawBody) {
      const parsed = parseOrThrow(
        SessionTargetFirstScopedEditRequestSchema,
        rawBody,
        'targetFirstScopedEdit',
      );
      const result = await registry.targetFirstScopedEdit({ request: parsed });
      const entry = parsed.apply === true && parsed.sessionId !== undefined
        ? registry.get(parsed.sessionId)
        : null;
      if (entry !== null) return wrap(entry, entry.session, { result });
      return {
        session: {
          sessionId: parsed.sessionId ?? 'preview',
          projectId: parsed.projectId,
          runId: parsed.runId,
          correlationId: parsed.correlationId,
          createdAtMs: Date.now(),
        },
        state: 'closed',
        historyLength: 0,
        data: { result },
      };
    },
  };
}
