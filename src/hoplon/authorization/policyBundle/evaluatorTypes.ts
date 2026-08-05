import type { ActiveGrant } from '../activeGrantClient.js';
import type { HoplonAuthorizationRequest } from '../authorizationAdapter.js';

export const BUNDLE_CAPABILITY_KEYS = [
  'read',
  'search',
  'write',
  'lock',
  'snapshot',
] as const;

export type BundleCapabilityKey = (typeof BUNDLE_CAPABILITY_KEYS)[number];

export type BundleOpaInput = {
  principal: HoplonAuthorizationRequest['principal'];
  task: HoplonAuthorizationRequest['task'];
  request: {
    projectId: string;
    branch: string;
    capabilities: ReadonlyArray<BundleCapabilityKey>;
    paths?: ReadonlyArray<string>;
    astSelectors?: ReadonlyArray<string>;
    astNodeIds?: ReadonlyArray<string>;
    reason?: string;
  };
  context: {
    sessionId: string;
    environment: 'dev' | 'staging' | 'prod';
    now: string;
  };
  activeGrants: ReadonlyArray<ActiveGrant>;
};

export type EvaluatorDeps = {
  generateDecisionId: () => string;
};
