/**
 * authorization/policyBundle/index.ts — public surface of the Hoplon OPA
 * policy bundle (T-149).
 *
 * STATUS: ADVISORY / FIXTURE-ONLY.
 *
 *   This module exposes:
 *     - The pinned bundle version string (`HOPLON_POLICY_BUNDLE_VERSION`),
 *       which matches `policy/data/hoplon_policy_data.json#policyVersion`.
 *     - The TypeScript types for the bundle data shape.
 *     - The pure parser (`parsePolicyDataJson`).
 *     - The in-process evaluator (`evaluatePolicyBundle`).
 *     - The `BundledOpaClient` (test/fixture-only, NOT for production use).
 *
 *   The production runtime adapter still uses `StaticAuthorizationAdapter`.
 *   `OpaAuthorizationAdapter` remains advisory-only per T-142.
 *
 * Architecture rules:
 *   - Re-exports only. No new behavior. Pure module.
 *   - Named exports only. TypeScript strict. No `any`.
 */
export {
  BUNDLE_CAPABILITY_KEYS,
  evaluatePolicyBundle,
  type BundleCapabilityKey,
  type BundleOpaInput,
  type EvaluatorDeps,
} from './evaluator.js';
export {
  BundledOpaClient,
  type BundledOpaClientDeps,
} from './bundledOpaClient.js';
export {
  parsePolicyDataJson,
  validatePolicyData,
  type LoadPolicyDataResult,
} from './loadPolicyData.js';
export type {
  BranchCapabilityDisposition,
  PolicyBranchRule,
  PolicyData,
  PolicyGlobalDeny,
  PolicyProject,
  PolicySensitivePath,
  ProjectCapabilityDisposition,
  SensitivePathCapabilityDisposition,
} from './types.js';

/**
 * Pinned policy bundle version. Tests assert this matches
 * `policy/data/hoplon_policy_data.json#policyVersion` so the JSON
 * fixture and the TS code cannot drift silently.
 */
export const HOPLON_POLICY_BUNDLE_VERSION =
  'hoplon_policy_bundle_2026_05_03';
