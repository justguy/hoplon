import type { VerifyBehaviorOptions } from '../contracts/verifyBehavior.js';
import type { SessionRegistry } from './registry.js';
import {
  SessionGetCloseoutProofBundleRequestSchema,
  SessionGetReviewPayloadRequestSchema,
  SessionRefSchema,
  SessionSnapshotEvidenceRequestSchema,
  SessionVerifyBehaviorRequestSchema,
  type SessionSnapshotEvidenceResult,
} from './transportContracts.js';
import type { SessionTransportDispatcher } from './transportDispatcherTypes.js';
import {
  parseOrThrow,
  requireEntry,
  toIdentity,
  toLineEvidenceTarget,
  wrap,
} from './transportSupport.js';

export function createSessionEvidenceHandlers(
  registry: SessionRegistry,
): Pick<
  SessionTransportDispatcher,
  | 'getCloseoutProofBundle'
  | 'getReviewPayload'
  | 'verifyBehavior'
  | 'inspect'
  | 'close'
  | 'list'
  | 'getSnapshotEvidence'
> {
  return {
    async getCloseoutProofBundle(rawBody) {
      const parsed = parseOrThrow(
        SessionGetCloseoutProofBundleRequestSchema,
        rawBody,
        'getCloseoutProofBundle',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const closeoutProofBundle = await entry.session.getCloseoutProofBundle({
        ...(parsed.includeReview !== undefined
          ? { includeReview: parsed.includeReview }
          : {}),
        ...(parsed.includeBehaviorVerification !== undefined
          ? { includeBehaviorVerification: parsed.includeBehaviorVerification }
          : {}),
        ...(parsed.proofVerbosity !== undefined
          ? { proofVerbosity: parsed.proofVerbosity }
          : {}),
      });
      return wrap(entry, entry.session, { closeoutProofBundle });
    },

    async getReviewPayload(rawBody) {
      const parsed = parseOrThrow(
        SessionGetReviewPayloadRequestSchema,
        rawBody,
        'getReviewPayload',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const callOpts: {
        phase?: 'post-edit' | 'preview';
        proposedChanges?: unknown[];
        contextLines?: number;
        includeDependencyImpact?: boolean;
        includeRelevantTests?: boolean;
        includePostEditPolicyScan?: boolean;
        dependencyImpactWarnThreshold?: number;
        dependencyImpactPrecomputedChangedFiles?: string[];
      } = {};
      if (parsed.phase !== undefined) callOpts.phase = parsed.phase;
      if (parsed.proposedChanges !== undefined) {
        callOpts.proposedChanges = [...parsed.proposedChanges];
      }
      if (parsed.contextLines !== undefined) {
        callOpts.contextLines = parsed.contextLines;
      }
      if (parsed.includeDependencyImpact !== undefined) {
        callOpts.includeDependencyImpact = parsed.includeDependencyImpact;
      }
      if (parsed.includeRelevantTests !== undefined) {
        callOpts.includeRelevantTests = parsed.includeRelevantTests;
      }
      if (parsed.includePostEditPolicyScan !== undefined) {
        callOpts.includePostEditPolicyScan = parsed.includePostEditPolicyScan;
      }
      if (parsed.dependencyImpactWarnThreshold !== undefined) {
        callOpts.dependencyImpactWarnThreshold = parsed.dependencyImpactWarnThreshold;
      }
      if (parsed.dependencyImpactPrecomputedChangedFiles !== undefined) {
        callOpts.dependencyImpactPrecomputedChangedFiles = [
          ...parsed.dependencyImpactPrecomputedChangedFiles,
        ];
      }
      const review = await entry.session.getReviewPayload(
        callOpts as Parameters<
          typeof entry.session.getReviewPayload
        >[0],
      );
      return wrap(entry, entry.session, { review });
    },

    async verifyBehavior(rawBody) {
      const parsed = parseOrThrow(
        SessionVerifyBehaviorRequestSchema,
        rawBody,
        'verifyBehavior',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const callOpts: VerifyBehaviorOptions = {};
      if (parsed.testsOverride !== undefined) {
        callOpts.testsOverride = [...parsed.testsOverride];
      }
      if (parsed.modifiedFilesOverride !== undefined) {
        callOpts.modifiedFilesOverride = [...parsed.modifiedFilesOverride];
      }
      if (parsed.testPatterns !== undefined) {
        callOpts.testPatterns = [...parsed.testPatterns];
      }
      if (parsed.maxDepth !== undefined) callOpts.maxDepth = parsed.maxDepth;
      if (parsed.onConservativeCoverage !== undefined) {
        callOpts.onConservativeCoverage = parsed.onConservativeCoverage;
      }
      if (parsed.timeoutMs !== undefined) callOpts.timeoutMs = parsed.timeoutMs;
      if (parsed.runnerMeta !== undefined) {
        callOpts.runnerMeta = { ...parsed.runnerMeta };
      }
      const verification = await entry.session.verifyBehavior(callOpts);
      return wrap(entry, entry.session, { verification });
    },

    async inspect(rawBody) {
      const parsed = parseOrThrow(SessionRefSchema, rawBody, 'inspect', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      return {
        session: toIdentity(entry),
        state: entry.session.state,
        snapshot: entry.session.snapshot,
      };
    },

    async close(rawBody) {
      const parsed = parseOrThrow(SessionRefSchema, rawBody, 'close', {
        requireSessionId: true,
      });
      const entry = requireEntry(registry, parsed.sessionId);
      const identity = toIdentity(entry);
      registry.close(parsed.sessionId);
      return {
        session: identity,
        state: 'closed',
        historyLength: entry.session.snapshot.history.length,
        data: { closed: true },
      };
    },

    list() {
      const sessions = registry.list().map((info) => ({
        sessionId: info.sessionId,
        projectId: info.projectId,
        runId: info.runId,
        correlationId: info.correlationId,
        createdAtMs: info.createdAtMs,
      }));
      return { sessions };
    },

    async getSnapshotEvidence(rawBody) {
      const parsed = parseOrThrow(
        SessionSnapshotEvidenceRequestSchema,
        rawBody,
        'getSnapshotEvidence',
        { requireSessionId: true },
      );
      const entry = requireEntry(registry, parsed.sessionId);
      const req = parsed.request;
      let evidence: Awaited<ReturnType<typeof entry.session.getSnapshotEvidence>>;
      if (req.kind === 'provenance') {
        evidence = await entry.session.getSnapshotEvidence({
          kind: 'provenance',
          snapshotRefId: req.snapshotRefId,
        });
      } else if (req.kind === 'line_provenance') {
        evidence = await entry.session.getSnapshotEvidence({
          kind: 'line_provenance',
          snapshotRefId: req.snapshotRefId,
          file: req.file,
          target: toLineEvidenceTarget(req.target),
        });
      } else {
        evidence = await entry.session.getSnapshotEvidence({
          kind: 'diff',
          fromSnapshotRefId: req.fromSnapshotRefId,
          to: req.to,
          ...(req.files !== undefined ? { files: req.files } : {}),
          ...(req.contextLines !== undefined
            ? { contextLines: req.contextLines }
            : {}),
        });
      }
      return wrap(entry, entry.session, {
        evidence: evidence as SessionSnapshotEvidenceResult,
      });
    },
  };
}
