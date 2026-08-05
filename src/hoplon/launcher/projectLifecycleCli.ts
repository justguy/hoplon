/**
 * launcher/projectLifecycleCli.ts — parsing + execution for the
 * `hoplon project renew|revoke|prune` subcommands introduced with
 * t-084.
 *
 * Kept separate from `projectCli.ts` so the main CLI file stays inside
 * the 300-line budget while still delegating to the one shared
 * lifecycle implementation. Transports (HTTP, MCP) call into the same
 * `engagementLifecycle` module directly; the CLI goes through this
 * thin adapter so error envelopes, exit codes, and messages match.
 */
import type { ProjectRegistry } from '../concurrency/projectRegistry.js';
import {
  pruneExpiredTokens,
  renewEngagementToken,
  revokeEngagementToken,
} from './engagementLifecycle.js';
import type { EngagementStore } from './engagementStore.js';

export type ProjectLifecycleSubcommand =
  | { kind: 'renew'; token: string }
  | { kind: 'revoke'; token: string }
  | { kind: 'prune' };

export type ProjectCommandOutcome =
  | { ok: true; body: unknown }
  | { ok: false; errorKind: string; message: string };

export const PROJECT_LIFECYCLE_HELP_TEXT = `Lifecycle subcommands (t-084):
  hoplon project renew  --token <opaque>    Re-run folder-policy resolution
                                            against the stored binding, return
                                            a renewed token envelope, and extend the
                                            expiry. Returns reauth_required
                                            with a typed reason when the
                                            handshake can no longer be issued
                                            (expired, revoked, policy changed).
  hoplon project revoke --token <opaque>    Remove a live binding. Idempotent
                                            — subsequent uses of the same
                                            token observe it as missing.
  hoplon project prune                      Drop every binding whose TTL has
                                            passed. Touches the engagement
                                            store only; sessions, snapshots,
                                            and audit state are never mutated.
`;

export function parseProjectLifecycleFlags(
  sub: 'renew' | 'revoke' | 'prune',
  flags: Map<string, string | undefined>,
): ProjectLifecycleSubcommand | { kind: 'error'; message: string } {
  if (sub === 'prune') return { kind: 'prune' };
  const token = flags.get('token');
  if (token === undefined || token.length === 0) {
    return { kind: 'error', message: `${sub} requires --token` };
  }
  return { kind: sub, token };
}

export interface RunLifecycleDeps {
  readonly store: EngagementStore;
  readonly registry: Pick<ProjectRegistry, 'get' | 'list'>;
  readonly clock?: () => Date;
}

export function runProjectLifecycleCommand(
  sub: ProjectLifecycleSubcommand,
  deps: RunLifecycleDeps,
): ProjectCommandOutcome {
  if (sub.kind === 'renew') {
    const outcome = renewEngagementToken(deps.store, sub.token, {
      registry: deps.registry,
      store: deps.store,
      ...(deps.clock !== undefined ? { clock: deps.clock } : {}),
    });
    if (outcome.kind === 'renewed') {
      return {
        ok: true,
        body: {
          kind: 'renewed',
          previousToken: outcome.previousToken,
          result: outcome.result,
        },
      };
    }
    return {
      ok: false,
      errorKind: 'reauth_required',
      message: `renew rejected: ${outcome.reason}`,
    };
  }
  if (sub.kind === 'revoke') {
    const outcome = revokeEngagementToken(deps.store, sub.token);
    if (outcome.kind === 'revoked') {
      return { ok: true, body: { kind: 'revoked' } };
    }
    return {
      ok: false,
      errorKind: 'missing_token',
      message: 'No live binding for the supplied token',
    };
  }
  // sub.kind === 'prune'
  const now = (deps.clock ?? (() => new Date()))();
  const report = pruneExpiredTokens(deps.store, now);
  return { ok: true, body: { kind: 'pruned', ...report } };
}
