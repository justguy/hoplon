import type { SnapshotStore } from '../../src/hoplon/adapters/snapshotStore.js';
import { createProjectRegistry } from '../../src/hoplon/concurrency/projectRegistry.js';
import type { FolderPolicy } from '../../src/hoplon/concurrency/projectPolicy.js';
import { validateFolderPolicy } from '../../src/hoplon/concurrency/projectPolicyValidation.js';
import {
  createInMemoryEngagementStore,
  issueProjectHandshake,
} from '../../src/hoplon/launcher/handshake.js';

export const FIXED_NOW = new Date('2026-04-24T10:00:00.000Z');
export const FIXED_TOKEN_A = 'a'.repeat(64);
export const FIXED_TOKEN_B = 'b'.repeat(64);
export const FIXED_NONCE_A = '1'.repeat(32);
export const FIXED_NONCE_B = '2'.repeat(32);

export function makePolicy(
  overrides: Partial<FolderPolicy> = {},
): FolderPolicy {
  return validateFolderPolicy({
    defaultAccess: 'read_only',
    engagementTokenTtlMs: 60_000,
    folderRules: [
      { folder: 'src', access: 'read_write' },
      { folder: 'src/hoplon', access: 'read_only' },
      { folder: 'docs', access: 'read_only' },
      { folder: 'secrets', access: 'none' },
      {
        folder: 'src',
        access: 'read_only',
        appliesToPrincipalIds: ['agent-a'],
      },
    ],
    principals: [
      { principalId: 'agent-a', kind: 'agent' },
      { principalId: 'agent-b', kind: 'agent' },
    ],
    ...overrides,
  });
}

export function registerProject(policy: FolderPolicy, projectId = 'p1') {
  const registry = createProjectRegistry();
  registry.register({
    projectId,
    fsRoot: '/tmp/hoplon-t087-fsroot',
    policy: { folderPolicy: policy },
  });
  return registry;
}

export function issueTestToken() {
  const registry = registerProject(makePolicy());
  const store = createInMemoryEngagementStore();
  const issued = issueProjectHandshake(
    { projectId: 'p1', folder: 'src', principalId: 'agent-b' },
    {
      registry,
      store,
      clock: () => FIXED_NOW,
      randomToken: () => FIXED_TOKEN_A,
      randomNonce: () => FIXED_NONCE_A,
    },
  );
  return { registry, store, issued, token: issued.engagement.token };
}

export function expectSingle<T>(items: readonly T[], label: string): T {
  if (items.length !== 1 || items[0] === undefined) {
    throw new Error(`expected exactly one ${label}; got ${items.length}`);
  }
  return items[0];
}

export function brokenAuditStore(): SnapshotStore {
  return {
    appendAuditLog: () => Promise.reject(new Error('simulated disk pressure')),
  } as unknown as SnapshotStore;
}
