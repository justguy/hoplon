/**
 * transport/strictSessionEngagement.ts — strict-agent session gate.
 *
 * Shared by HTTP and MCP session wrappers so strict edit-session requests use
 * one engagement check and one policy-audit path.
 *
 * hcr-004 finding 4: strict session authorization is owner-bound. Session
 * creation records the verified creator scope on the registry entry (via the
 * dispatcher), and every session-scoped call verifies the presented token
 * against that recorded owner — a different valid project token is a typed
 * 403 denial, audited through the existing policy-audit seam. The verified
 * engagement folder is additionally compared against manifest entries and
 * edited file paths; escapes are strict-file-policy denials.
 */

import type {
  RegisteredSessionEntry,
  SessionRegistry,
} from '../session/registry.js';
import {
  StartSessionRequestSchema,
  SessionRefSchema,
  SessionQuickEditRequestSchema,
  SessionTargetFirstScopedEditRequestSchema,
} from '../session/transportContracts.js';
import {
  StrictEngagementContextSchema,
  type StrictEngagementContext,
} from '../contracts/engagementContext.js';
import type { HttpSessionOp } from './agentToolProfile.js';
import { assertStrictSessionPathsWithinFolder } from './strictAgentFilePolicy.js';
import {
  StrictEngagementError,
  verifyStrictEngagementAccess,
  type StrictEngagementGateDeps,
} from './strictEngagementGate.js';
import { strictCapabilityFromBody } from './strictEngagementCheck.js';

export async function enforceStrictSessionEngagement(args: {
  readonly gate?: StrictEngagementGateDeps;
  readonly registry: SessionRegistry;
  readonly op: HttpSessionOp;
  readonly rawBody: unknown;
}): Promise<void> {
  if (!args.gate || !requiresSessionEngagement(args.op)) return;

  if (args.op === 'start') {
    await enforceStartEngagement(args.gate, args.rawBody);
    return;
  }
  if (args.op === 'quickEdit' || args.op === 'targetFirstScopedEdit') {
    await enforceManifestOpEngagement(args.gate, args.op, args.rawBody);
    return;
  }

  const parsed = SessionRefSchema.safeParse(args.rawBody);
  if (!parsed.success) return;
  const entry = args.registry.get(parsed.data.sessionId);
  if (!entry) return;
  const editPaths = sessionEditPathsFromBody(args.op, rawBodyRecord(args.rawBody));
  const capability = strictCapabilityFromBody(
    rawBodyRecord(args.rawBody),
    entry.correlationId,
  );
  await verifyStrictEngagementAccess(args.gate, {
    ...(parsed.data.engagement !== undefined
      ? { engagement: parsed.data.engagement }
      : {}),
    projectId: entry.projectId,
    runId: entry.runId,
    correlationId: entry.correlationId,
    action: 'edit',
    requiredAccess: 'read_write',
    ...(entry.owner !== undefined ? { expectedScope: entry.owner } : {}),
    ...(capability !== undefined ? { capability } : {}),
    derivedCapability: {
      key: 'write',
      branch: '',
      paths: editPaths.length > 0 ? editPaths : sessionManifestPaths(entry),
      sessionId: entry.sessionId,
    },
  });
  assertSessionOwnerScope(entry, parsed.data.engagement);
  if (parsed.data.engagement !== undefined && editPaths.length > 0) {
    assertStrictSessionPathsWithinFolder(editPaths, parsed.data.engagement.folder);
  }
}

async function enforceStartEngagement(
  gate: StrictEngagementGateDeps,
  rawBody: unknown,
): Promise<void> {
  const parsed = StartSessionRequestSchema.safeParse(rawBody);
  if (!parsed.success) return;
  const correlationId =
    parsed.data.correlationId ?? parsed.data.manifest.correlationId;
  const capability = strictCapabilityFromBody(rawBodyRecord(rawBody), correlationId);
  const manifestPaths = parsed.data.manifest.entries.map((entry) => entry.path);
  await verifyStrictEngagementAccess(gate, {
    ...(parsed.data.engagement !== undefined
      ? { engagement: parsed.data.engagement }
      : {}),
    projectId: parsed.data.manifest.projectId,
    runId: parsed.data.manifest.runId,
    correlationId,
    action: 'edit',
    requiredAccess: 'read_write',
    ...(capability !== undefined ? { capability } : {}),
    derivedCapability: { key: 'write', branch: '', paths: manifestPaths },
  });
  if (parsed.data.engagement !== undefined) {
    assertStrictSessionPathsWithinFolder(
      manifestPaths,
      parsed.data.engagement.folder,
    );
  }
}

/**
 * quickEdit / targetFirstScopedEdit carry a manifest instead of a
 * sessionId. Both are write-lane calls; before hcr-004 they silently
 * bypassed the strict gate because the SessionRef parse failed. They now
 * require a verified read_write engagement whose folder contains every
 * manifest / proposed-change path.
 */
async function enforceManifestOpEngagement(
  gate: StrictEngagementGateDeps,
  op: 'quickEdit' | 'targetFirstScopedEdit',
  rawBody: unknown,
): Promise<void> {
  const raw = rawBodyRecord(rawBody);
  const engagement = parseLooseEngagement(raw['engagement']);
  let scope:
    | { projectId: string; runId: string; correlationId: string; paths: string[] }
    | null = null;
  if (op === 'quickEdit') {
    const parsed = SessionQuickEditRequestSchema.safeParse(rawBody);
    if (!parsed.success) return;
    scope = {
      projectId: parsed.data.manifest.projectId,
      runId: parsed.data.manifest.runId,
      correlationId:
        parsed.data.correlationId ?? parsed.data.manifest.correlationId,
      paths: [
        ...parsed.data.manifest.entries.map((entry) => entry.path),
        ...(parsed.data.proposedChanges ?? []).map((change) => change.file),
        ...(parsed.data.markEditedFiles ?? []),
      ],
    };
  } else {
    const parsed = SessionTargetFirstScopedEditRequestSchema.safeParse(rawBody);
    if (!parsed.success) return;
    scope = {
      projectId: parsed.data.projectId,
      runId: parsed.data.runId,
      correlationId: parsed.data.correlationId,
      paths: [
        ...(parsed.data.acceptedManifest?.entries.map((entry) => entry.path) ??
          []),
        ...(parsed.data.proposedChanges ?? []).map((change) => change.file),
      ],
    };
  }
  const paths = [...new Set(scope.paths)];
  const capability = strictCapabilityFromBody(raw, scope.correlationId);
  await verifyStrictEngagementAccess(gate, {
    ...(engagement !== undefined ? { engagement } : {}),
    projectId: scope.projectId,
    runId: scope.runId,
    correlationId: scope.correlationId,
    action: 'edit',
    requiredAccess: 'read_write',
    ...(capability !== undefined ? { capability } : {}),
    derivedCapability: { key: 'write', branch: '', paths },
  });
  if (engagement !== undefined) {
    assertStrictSessionPathsWithinFolder(paths, engagement.folder);
  }
}

/**
 * hcr-004 — a strict session must carry a recorded owner, and the caller's
 * verified engagement must match it exactly. The token-vs-owner comparison
 * already happened (and was audited) inside the gate via `expectedScope`;
 * this closes the residual case of an owner-bound token presented with a
 * mismatched context.
 */
function assertSessionOwnerScope(
  entry: RegisteredSessionEntry,
  engagement: StrictEngagementContext | undefined,
): void {
  if (entry.owner === undefined) {
    throw new StrictEngagementError({
      kind: 'engagement_session_unowned',
      correlationId: entry.correlationId,
      statusCode: 403,
    });
  }
  if (engagement === undefined) return; // unreachable post-gate; defensive
  if (engagement.folder !== entry.owner.folder) {
    throw new StrictEngagementError({
      kind: 'engagement_scope_mismatch_folder',
      correlationId: entry.correlationId,
      statusCode: 403,
    });
  }
  if (engagement.principalId !== entry.owner.principalId) {
    throw new StrictEngagementError({
      kind: 'engagement_scope_mismatch_principal',
      correlationId: entry.correlationId,
      statusCode: 403,
    });
  }
}

/** File paths a session-scoped call proposes to edit, when it names any. */
function sessionEditPathsFromBody(
  op: HttpSessionOp,
  raw: Record<string, unknown>,
): string[] {
  if (op === 'applyEdits' || op === 'dryRun') {
    const changes = raw['proposedChanges'];
    if (!Array.isArray(changes)) return [];
    const files: string[] = [];
    for (const change of changes) {
      if (typeof change !== 'object' || change === null) continue;
      const file = (change as { file?: unknown }).file;
      if (typeof file === 'string' && file.length > 0) files.push(file);
    }
    return [...new Set(files)];
  }
  if (op === 'markEdited') {
    const files = raw['files'];
    if (!Array.isArray(files)) return [];
    return [
      ...new Set(
        files.filter(
          (file): file is string => typeof file === 'string' && file.length > 0,
        ),
      ),
    ];
  }
  return [];
}

function sessionManifestPaths(entry: RegisteredSessionEntry): string[] {
  return entry.session.snapshot.manifest.entries.map(
    (manifestEntry) => manifestEntry.path,
  );
}

function parseLooseEngagement(
  rawEngagement: unknown,
): StrictEngagementContext | undefined {
  if (rawEngagement === undefined) return undefined;
  const parsed = StrictEngagementContextSchema.safeParse(rawEngagement);
  return parsed.success ? parsed.data : undefined;
}

function requiresSessionEngagement(op: HttpSessionOp): boolean {
  return op !== 'list';
}

function rawBodyRecord(rawBody: unknown): Record<string, unknown> {
  return typeof rawBody === 'object' && rawBody !== null
    ? rawBody as Record<string, unknown>
    : {};
}
