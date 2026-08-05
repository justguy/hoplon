/**
 * operations/seeCodebasePlanning.ts — target capability checks and execution
 * planning for `seeCodebase`.
 */

import type {
  SeeCodebaseSelectedPath,
  SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import { isJsTsPath } from './seeCodebaseFilePolicy.js';
import type { RouteDecision } from './seeCodebaseRouting.js';

type PathLabel = 'structural' | 'skeleton' | 'raw';

export interface SeeCodebaseExecutionPlan {
  selectedPath: SeeCodebaseSelectedPath;
  routingReason: string;
  requestedPathLabel: PathLabel;
  fallbackPathLabel?: PathLabel;
  fallbackOccurred: boolean;
  structuralTargets: SeeCodebaseTarget[];
  skeletonTargets: SeeCodebaseTarget[];
  rawTargets: SeeCodebaseTarget[];
}

export type SeeCodebaseExecutionDecision =
  | { kind: 'ok'; plan: SeeCodebaseExecutionPlan }
  | { kind: 'strict_block'; plan: SeeCodebaseExecutionPlan; message: string }
  | { kind: 'unsupported'; plan: SeeCodebaseExecutionPlan; message: string };

export function canServeStructuralTarget(target: SeeCodebaseTarget): boolean {
  if (target.kind === 'project') return true;
  if (target.kind === 'symbol') {
    return target.file === undefined || isJsTsPath(target.file);
  }
  if (target.kind === 'ast_node') return isJsTsPath(target.file);
  if (target.kind === 'edit_slice') return false;
  if (target.kind === 'file') return isJsTsPath(target.path);
  return false;
}

export function canServeSkeletonTarget(target: SeeCodebaseTarget): boolean {
  if (target.kind === 'file') return isJsTsPath(target.path);
  return target.kind === 'symbol' && typeof target.file === 'string' && isJsTsPath(target.file);
}

export function canServeRawTarget(target: SeeCodebaseTarget): boolean {
  if (target.kind === 'ast_node') return false;
  return (
    target.kind === 'file' ||
    target.kind === 'edit_slice' ||
    target.kind === 'pattern' ||
    target.kind === 'symbol'
  );
}

export function resolveExecutionPlan(
  route: RouteDecision,
  targets: readonly SeeCodebaseTarget[],
  strict: boolean,
): SeeCodebaseExecutionDecision {
  const basePlan: SeeCodebaseExecutionPlan = {
    selectedPath: route.selectedPath,
    routingReason: route.routingReason,
    requestedPathLabel: route.requestedPathLabel,
    ...(route.fallbackPathLabel !== undefined ? { fallbackPathLabel: route.fallbackPathLabel } : {}),
    fallbackOccurred: route.fallbackPathLabel !== undefined,
    structuralTargets: [],
    skeletonTargets: [],
    rawTargets: [],
  };

  if (route.selectedPath === 'raw') {
    const unsupported = targets.filter((target) => !canServeRawTarget(target));
    return unsupported.length === 0
      ? { kind: 'ok', plan: { ...basePlan, rawTargets: targets.filter(canServeRawTarget) } }
      : unsupportedDecision(basePlan, unsupported);
  }
  if (route.selectedPath === 'skeleton') {
    return finalizePlan(
      { ...basePlan, skeletonTargets: targets.filter(canServeSkeletonTarget) },
      targets.filter(canServeRawTarget),
      targets,
      strict,
    );
  }
  if (route.selectedPath === 'structural') {
    return finalizePlan(
      { ...basePlan, structuralTargets: targets.filter(canServeStructuralTarget) },
      targets.filter(canServeRawTarget),
      targets,
      strict,
    );
  }
  if (route.selectedPath === 'skeleton+raw') {
    return ensureCoverage({
      ...basePlan,
      skeletonTargets: targets.filter(canServeSkeletonTarget),
      rawTargets: targets.filter(canServeRawTarget),
    }, targets);
  }
  return ensureCoverage({
    ...basePlan,
    structuralTargets: targets.filter(canServeStructuralTarget),
    rawTargets: targets.filter(canServeRawTarget),
  }, targets);
}

function finalizePlan(
  plan: SeeCodebaseExecutionPlan,
  rawEligibleTargets: readonly SeeCodebaseTarget[],
  allTargets: readonly SeeCodebaseTarget[],
  strict: boolean,
): SeeCodebaseExecutionDecision {
  const covered = new Set<SeeCodebaseTarget>([
    ...plan.structuralTargets,
    ...plan.skeletonTargets,
  ]);
  const unhandled = allTargets.filter((target) => !covered.has(target));
  if (unhandled.length === 0) return { kind: 'ok', plan };
  if (unhandled.every(canServeRawTarget)) {
    const supplemented: SeeCodebaseExecutionPlan = {
      ...plan,
      selectedPath:
        covered.size > 0
          ? plan.requestedPathLabel === 'skeleton'
            ? 'skeleton+raw'
            : 'structural+raw'
          : 'raw',
      routingReason:
        covered.size > 0
          ? `${plan.routingReason}; raw supplement required for unsupported targets`
          : `${plan.routingReason}; raw fallback required for unsupported targets`,
      fallbackPathLabel: 'raw',
      fallbackOccurred: true,
      rawTargets: rawEligibleTargets.filter((target) => !covered.has(target)),
    };
    if (strict) {
      return {
        kind: 'strict_block',
        plan: supplemented,
        message: `strict:true blocked fallback from ${plan.requestedPathLabel} to raw`,
      };
    }
    return { kind: 'ok', plan: supplemented };
  }
  return unsupportedDecision(plan, unhandled);
}

function ensureCoverage(
  plan: SeeCodebaseExecutionPlan,
  allTargets: readonly SeeCodebaseTarget[],
): SeeCodebaseExecutionDecision {
  const covered = new Set<SeeCodebaseTarget>([
    ...plan.structuralTargets,
    ...plan.skeletonTargets,
    ...plan.rawTargets,
  ]);
  const unhandled = allTargets.filter((target) => !covered.has(target));
  return unhandled.length === 0 ? { kind: 'ok', plan } : unsupportedDecision(plan, unhandled);
}

function unsupportedDecision(
  plan: SeeCodebaseExecutionPlan,
  targets: readonly SeeCodebaseTarget[],
): SeeCodebaseExecutionDecision {
  return {
    kind: 'unsupported',
    plan,
    message: `see_codebase cannot serve target(s) on the requested path: ${targets.map(describeTarget).join('; ')}`,
  };
}

function describeTarget(target: SeeCodebaseTarget): string {
  if (target.kind === 'project') return 'project target requires a structural route';
  if (target.kind === 'file') return `file:${target.path}`;
  if (target.kind === 'edit_slice') {
    return `edit_slice:${target.path}:${target.startLine}-${target.endLine}`;
  }
  if (target.kind === 'symbol') {
    return typeof target.file === 'string' ? `symbol:${target.name}@${target.file}` : `symbol:${target.name}`;
  }
  if (target.kind === 'ast_node') return `ast_node:${target.file}`;
  return `pattern:${target.regex}`;
}
