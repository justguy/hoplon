/**
 * operations/seeCodebaseRouting.ts — t-061 routing helpers for
 * `see_codebase`.
 *
 * Classifies file-kind support (for auto routing driver #2) and picks the
 * selected path + routing reason. Extension-only routing is explicitly
 * rejected per the t-060 contract — intent always participates.
 *
 * Import wall: contracts + sibling ops only.
 */

import type {
  SeeCodebaseIntent,
  SeeCodebaseFileKindSupport,
  SeeCodebaseMode,
  SeeCodebaseSelectedPath,
  SeeCodebaseTarget,
} from '../contracts/seeCodebase.js';
import { classifySeeCodebasePath, isJsTsPath } from './seeCodebaseFilePolicy.js';

export function classifyFileKindSupport(
  targets: readonly SeeCodebaseTarget[],
): SeeCodebaseFileKindSupport {
  const paths: string[] = [];
  for (const t of targets) {
    if (t.kind === 'file') paths.push(t.path);
    else if (t.kind === 'symbol' && typeof t.file === 'string') paths.push(t.file);
    else if (t.kind === 'ast_node') paths.push(t.file);
    else if (t.kind === 'edit_slice') paths.push(t.path);
    else if (t.kind === 'pattern' && Array.isArray(t.scope)) {
      for (const p of t.scope) paths.push(p);
    }
  }
  if (paths.length === 0) return 'not_applicable';

  let jsTs = 0;
  let otherSupported = 0;
  let unsupported = 0;
  for (const p of paths) {
    if (isJsTsPath(p)) jsTs += 1;
    else if (classifySeeCodebasePath(p).supportedInStrict) otherSupported += 1;
    else unsupported += 1;
  }
  if (jsTs > 0 && otherSupported === 0 && unsupported === 0) return 'js_ts';
  if (jsTs === 0 && otherSupported > 0 && unsupported === 0) {
    return 'other_supported';
  }
  if (jsTs === 0 && otherSupported === 0 && unsupported > 0) return 'unsupported';
  return 'mixed';
}

// ---------------------------------------------------------------------------
// Auto-route decision
// ---------------------------------------------------------------------------

export interface RouteDecision {
  selectedPath: SeeCodebaseSelectedPath;
  routingReason: string;
  /**
   * Requested-path label for error reporting when strict blocks a
   * fallback. Always one of 'structural' | 'skeleton' | 'raw'.
   */
  requestedPathLabel: 'structural' | 'skeleton' | 'raw';
  /**
   * Fallback label the auto-router would have chosen. Populated when the
   * caller asked for a path that needs to be substituted (e.g. structural
   * on an unsupported grammar). Used for `fallbackOccurred` reporting and
   * for the `STRICT_BLOCKED_FALLBACK` suggestedPath.
   */
  fallbackPathLabel?: 'structural' | 'skeleton' | 'raw';
}

export function decideRoute(
  intent: SeeCodebaseIntent,
  mode: SeeCodebaseMode,
  fileKind: SeeCodebaseFileKindSupport,
  targets: readonly SeeCodebaseTarget[],
): RouteDecision {
  if (mode === 'raw') {
    return {
      selectedPath: 'raw',
      routingReason: 'mode:raw requested; raw path honored without fallback',
      requestedPathLabel: 'raw',
    };
  }
  if (mode === 'skeleton') {
    if (fileKind === 'unsupported') {
      return {
        selectedPath: 'raw',
        routingReason:
          'mode:skeleton requested on unsupported grammar; fallback to raw (extractStructuralTemplate covers JS/TS only)',
        requestedPathLabel: 'skeleton',
        fallbackPathLabel: 'raw',
      };
    }
    return {
      selectedPath: 'skeleton',
      routingReason:
        'mode:skeleton requested; reuses extractStructuralTemplate basis',
      requestedPathLabel: 'skeleton',
    };
  }
  if (mode === 'structural') {
    if (fileKind === 'unsupported') {
      return {
        selectedPath: 'raw',
        routingReason:
          'mode:structural requested on unsupported grammar; fallback to raw',
        requestedPathLabel: 'structural',
        fallbackPathLabel: 'raw',
      };
    }
    return {
      selectedPath: 'structural',
      routingReason: 'mode:structural requested',
      requestedPathLabel: 'structural',
    };
  }
  // mode === 'auto' — routing matrix from t-060 §5.
  return decideAuto(intent, fileKind, targets);
}

function decideAuto(
  intent: SeeCodebaseIntent,
  fileKind: SeeCodebaseFileKindSupport,
  targets: readonly SeeCodebaseTarget[],
): RouteDecision {
  switch (intent) {
    case 'read_exact_text':
      return {
        selectedPath: 'raw',
        routingReason:
          'exact-text request; structural reads would lose verbatim bytes',
        requestedPathLabel: 'raw',
      };
    case 'search_exact_text':
      return {
        selectedPath: 'raw',
        routingReason: 'raw text grep is the only correct path for literal-text queries',
        requestedPathLabel: 'raw',
      };
    case 'inspect_docs_or_config':
      return {
        selectedPath: 'raw',
        routingReason: 'docs/config are not structural code under this contract',
        requestedPathLabel: 'raw',
      };
    case 'inspect_logs_or_env':
      return {
        selectedPath: 'raw',
        routingReason: 'logs/env are not structural code under this contract',
        requestedPathLabel: 'raw',
      };
    case 'orient_project':
      return {
        selectedPath: 'structural',
        routingReason:
          'project overview comes from describeProject / describeCapabilities',
        requestedPathLabel: 'structural',
      };
    case 'understand_code_shape':
      if (fileKind === 'unsupported') {
        return {
          selectedPath: 'raw',
          routingReason: 'no structural grammar; raw fallback',
          requestedPathLabel: 'structural',
          fallbackPathLabel: 'raw',
        };
      }
      return {
        selectedPath: 'structural',
        routingReason:
          'structural-preferred for code understanding on supported language',
        requestedPathLabel: 'structural',
      };
    case 'find_symbol':
      if (fileKind === 'unsupported') {
        return {
          selectedPath: 'raw',
          routingReason: 'no AST symbol search for this language; raw fallback',
          requestedPathLabel: 'structural',
          fallbackPathLabel: 'raw',
        };
      }
      return {
        selectedPath: 'structural',
        routingReason:
          'AST-aware symbol search beats text grep for declared symbols',
        requestedPathLabel: 'structural',
      };
    case 'mixed': {
      const hasRawish = targets.some(
        (t) => t.kind === 'pattern' || t.kind === 'file' || t.kind === 'edit_slice',
      );
      const hasStructural = targets.some(
        (t) => t.kind === 'symbol' || t.kind === 'ast_node' || t.kind === 'project',
      );
      if (hasRawish && hasStructural) {
        return {
          selectedPath: 'structural+raw',
          routingReason:
            'request asked for both shapes; envelope reports both paths used',
          requestedPathLabel: 'structural',
        };
      }
      if (hasStructural) {
        return {
          selectedPath: 'structural',
          routingReason: 'mixed intent with structural-only targets',
          requestedPathLabel: 'structural',
        };
      }
      return {
        selectedPath: 'raw',
        routingReason: 'mixed intent with raw-only targets',
        requestedPathLabel: 'raw',
      };
    }
  }
}
