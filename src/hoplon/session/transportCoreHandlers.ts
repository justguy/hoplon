import type { RepairContextOptions } from './types.js';
import type { SessionRegistry } from './registry.js';
import {
  SessionApplyEditsRequestSchema,
  SessionDryRunRequestSchema,
  SessionExtractRollbackTemplateRequestSchema,
  SessionGetRepairContextRequestSchema,
  SessionMarkEditedRequestSchema,
  SessionRefSchema,
  SessionStageContentRequestSchema,
  StartSessionRequestSchema,
} from './transportContracts.js';
import type { SessionTransportDispatcher } from './transportDispatcherTypes.js';
import {
  parseOrThrow,
  requireEntry,
  SessionTransportError,
  wrap,
} from './transportSupport.js';

export function createSessionCoreHandlers(
  registry: SessionRegistry,
): Pick<
  SessionTransportDispatcher,
  | 'start'
  | 'preflight'
  | 'createSnapshot'
  | 'dryRun'
  | 'applyEdits'
  | 'stageContent'
  | 'markEdited'
  | 'audit'
  | 'revert'
  | 'extractRollbackTemplate'
  | 'getRepairContext'
> {
  return {
    async start(rawBody) {
      const parsed = parseOrThrow(StartSessionRequestSchema, rawBody, 'start');
      if (parsed.sessionId !== undefined && registry.get(parsed.sessionId)) {
        throw new SessionTransportError(
          'invalid_request',
          `start: sessionId already exists: ${parsed.sessionId}`,
          parsed.sessionId,
        );
      }
      const startArgs: Parameters<typeof registry.start>[0] = {
        manifest: parsed.manifest,
      };
      if (parsed.correlationId !== undefined) startArgs.correlationId = parsed.correlationId;
      if (parsed.sessionId !== undefined) startArgs.sessionId = parsed.sessionId;
      if (parsed.priorRepairContext !== undefined) {
        startArgs.priorRepairContext = parsed.priorRepairContext;
      }
      // hcr-004: record the creator identity on the session record. Strict
      // transports verify the engagement before dispatch reaches this point;
      // without a strict gate the owner is inert metadata.
      if (parsed.engagement !== undefined) {
        startArgs.owner = {
          principalId: parsed.engagement.principalId,
          folder: parsed.engagement.folder,
        };
      }
      const entry = await registry.start(startArgs);
      return wrap(entry, entry.session, {
        engineId: entry.session.snapshot.engineId,
      });
    },

    async preflight(rawBody) {
      const parsed = parseOrThrow(SessionRefSchema, rawBody, 'preflight', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      const result = await entry.session.preflight();
      return wrap(entry, entry.session, { result });
    },

    async createSnapshot(rawBody) {
      const parsed = parseOrThrow(SessionRefSchema, rawBody, 'createSnapshot', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      const snapshotRef = await entry.session.createSnapshot();
      return wrap(entry, entry.session, { snapshotRef });
    },

    async dryRun(rawBody) {
      const parsed = parseOrThrow(SessionDryRunRequestSchema, rawBody, 'dryRun', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      const result = await entry.session.dryRun(parsed.proposedChanges, {
        ...(parsed.invariantBindings !== undefined
          ? { invariantBindings: parsed.invariantBindings }
          : {}),
      });
      return wrap(entry, entry.session, { result });
    },

    async applyEdits(rawBody) {
      const parsed = parseOrThrow(
        SessionApplyEditsRequestSchema,
        rawBody,
        'applyEdits',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const result = await entry.session.applyEdits(parsed.proposedChanges);
      return wrap(entry, entry.session, {
        changedFiles: result.changedFiles,
        bytesWritten: result.bytesWritten,
        changeKindCounts: result.changeKindCounts,
        ...(result.overlayRefresh !== undefined
          ? { overlayRefresh: result.overlayRefresh }
          : {}),
      });
    },

    async stageContent(rawBody) {
      const parsed = parseOrThrow(
        SessionStageContentRequestSchema,
        rawBody,
        'stageContent',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      let chunkBytes: Uint8Array;
      try {
        chunkBytes = new Uint8Array(Buffer.from(parsed.chunk, 'base64'));
      } catch (cause) {
        throw new SessionTransportError(
          'invalid_request',
          `stageContent: chunk is not valid base64: ${(cause as Error).message}`,
          parsed.sessionId,
        );
      }
      const stageArgs: {
        stagingKey: string;
        seq: number;
        chunkBytes: Uint8Array;
        isFinal: boolean;
        expectedTotalSha256?: string;
        expectedTotalByteLength?: number;
      } = {
        stagingKey: parsed.stagingKey,
        seq: parsed.seq,
        chunkBytes,
        isFinal: parsed.isFinal,
      };
      if (parsed.expectedTotalSha256 !== undefined) {
        stageArgs.expectedTotalSha256 = parsed.expectedTotalSha256;
      }
      if (parsed.expectedTotalByteLength !== undefined) {
        stageArgs.expectedTotalByteLength = parsed.expectedTotalByteLength;
      }
      const result = entry.session.stageContent(stageArgs);
      return wrap(entry, entry.session, result);
    },

    async markEdited(rawBody) {
      const parsed = parseOrThrow(
        SessionMarkEditedRequestSchema,
        rawBody,
        'markEdited',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const result = await entry.session.markEdited(parsed.files);
      return wrap(entry, entry.session, result);
    },

    async audit(rawBody) {
      const parsed = parseOrThrow(SessionRefSchema, rawBody, 'audit', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      const result = await entry.session.audit();
      return wrap(entry, entry.session, { result });
    },

    async revert(rawBody) {
      const parsed = parseOrThrow(SessionRefSchema, rawBody, 'revert', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      const result = await entry.session.revert();
      return wrap(entry, entry.session, { result });
    },

    async extractRollbackTemplate(rawBody) {
      const parsed = parseOrThrow(
        SessionExtractRollbackTemplateRequestSchema,
        rawBody,
        'extractRollbackTemplate',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const callOpts: {
        files?: readonly string[];
        contractedChangesMap?: Readonly<Record<string, string>>;
      } = {};
      if (parsed.files !== undefined) callOpts.files = parsed.files;
      if (parsed.contractedChangesMap !== undefined) {
        callOpts.contractedChangesMap = parsed.contractedChangesMap;
      }
      const template = await entry.session.extractRollbackTemplate(callOpts);
      return wrap(entry, entry.session, { template });
    },

    async getRepairContext(rawBody) {
      const parsed = parseOrThrow(
        SessionGetRepairContextRequestSchema,
        rawBody,
        'getRepairContext',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const callOpts: RepairContextOptions = {
        ...(parsed.includeDependencyImpact !== undefined
          ? { includeDependencyImpact: parsed.includeDependencyImpact }
          : {}),
        ...(parsed.warnThreshold !== undefined
          ? { warnThreshold: parsed.warnThreshold }
          : {}),
        ...(parsed.behaviorVerification !== undefined
          ? { behaviorVerification: parsed.behaviorVerification }
          : {}),
        ...(parsed.includeRetryContextCompression !== undefined
          ? { includeRetryContextCompression: parsed.includeRetryContextCompression }
          : {}),
      };
      const repairContext = await entry.session.getRepairContext(callOpts);
      return wrap(entry, entry.session, { repairContext });
    },
  };
}
