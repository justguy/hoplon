import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type {
  DeclarativeInvariantBinding,
  DeclarativeInvariantReport,
  InvariantCheckResult,
} from '../contracts/invariantBinding.js';
import type { MaterializedDryRunChange } from './dryRunMaterializeChanges.js';
import {
  type ParsedPreviewFile,
  type ResolvedTargetNode,
  findExportedNode,
  hasField,
  hasReturnAnnotation,
  invariantResult,
  isAsyncNode,
  isFunctionLike,
  makeProvenance,
  parsePreviewFile,
  resolveInvariantTarget,
} from './invariantBindingAst.js';

export interface EvaluateInvariantBindingsInput {
  readonly codeIntelligence: CodeIntelligenceAdapter;
  readonly changes: readonly MaterializedDryRunChange[];
  readonly invariants: readonly DeclarativeInvariantBinding[];
  readonly signal?: AbortSignal | undefined;
}

export async function evaluateInvariantBindings(
  input: EvaluateInvariantBindingsInput,
): Promise<DeclarativeInvariantReport> {
  const files = new Map<string, MaterializedDryRunChange>();
  for (const change of input.changes) files.set(change.file, change);
  const parsedFiles = new Map<string, ParsedPreviewFile | InvariantCheckResult>();

  const results: InvariantCheckResult[] = [];
  for (const invariant of [...input.invariants].sort((a, b) =>
    a.id.localeCompare(b.id),
  )) {
    if (input.signal?.aborted) throw abortError(input.signal);
    results.push(
      await evaluateOne({
        invariant,
        files,
        parsedFiles,
        codeIntelligence: input.codeIntelligence,
        signal: input.signal,
      }),
    );
  }

  return { version: 1, blockingEnabled: false, results };
}

async function evaluateOne(input: {
  readonly invariant: DeclarativeInvariantBinding;
  readonly files: ReadonlyMap<string, MaterializedDryRunChange>;
  readonly parsedFiles: Map<string, ParsedPreviewFile | InvariantCheckResult>;
  readonly codeIntelligence: CodeIntelligenceAdapter;
  readonly signal?: AbortSignal | undefined;
}): Promise<InvariantCheckResult> {
  const invariant = input.invariant;
  if (invariant.kind === 'unsupported') {
    return invariantResult(invariant, 'UNSUPPORTED', 'unsupported_invariant_kind',
      `Unsupported invariant kind "${invariant.requestedKind}".`, null);
  }

  if (invariant.kind === 'exported_symbol_exists') {
    const parsed = await parsePreviewFile({
      file: invariant.file,
      invariant,
      files: input.files,
      parsedFiles: input.parsedFiles,
      codeIntelligence: input.codeIntelligence,
      signal: input.signal,
    });
    if ('status' in parsed) return parsed;
    const exported = findExportedNode(parsed.tree, invariant.symbolName);
    if (exported === null) {
      return invariantResult(invariant, 'REJECTED', 'missing_export',
        `Exported symbol "${invariant.symbolName}" was not found.`, null);
    }
    const provenance = makeProvenance(parsed, [invariant.symbolName], exported);
    if (
      invariant.expectedNodeKind !== undefined &&
      exported.kind !== invariant.expectedNodeKind
    ) {
      return invariantResult(invariant, 'REJECTED', 'node_kind_mismatch',
        `Exported symbol "${invariant.symbolName}" resolved to ${exported.kind}.`,
        provenance);
    }
    return invariantResult(invariant, 'PROVED', 'proved',
      `Exported symbol "${invariant.symbolName}" exists.`, provenance);
  }

  const target = await resolveInvariantTarget({
    target: invariant.target,
    invariant,
    files: input.files,
    parsedFiles: input.parsedFiles,
    codeIntelligence: input.codeIntelligence,
    signal: input.signal,
  });
  if ('status' in target) return target;

  if (invariant.kind === 'function_shape') {
    return evaluateFunctionShape(invariant, target);
  }
  if (invariant.kind === 'dto_field_presence') {
    return hasField(target.node, invariant.fieldName)
      ? invariantResult(invariant, 'PROVED', 'proved',
          `DTO field "${invariant.fieldName}" is present.`, target.provenance)
      : invariantResult(invariant, 'REJECTED', 'missing_field',
          `DTO field "${invariant.fieldName}" is missing.`, target.provenance);
  }

  const missing = invariant.requiredFields.filter((field) => !hasField(target.node, field));
  return missing.length === 0
    ? invariantResult(invariant, 'PROVED', 'proved',
        'Route/tool contract shape contains all required fields.', target.provenance)
    : invariantResult(invariant, 'REJECTED', 'missing_required_field',
        `Route/tool contract shape is missing required field "${missing[0]}".`,
        target.provenance);
}

function evaluateFunctionShape(
  invariant: Extract<DeclarativeInvariantBinding, { kind: 'function_shape' }>,
  target: ResolvedTargetNode,
): InvariantCheckResult {
  if (!isFunctionLike(target.node.kind)) {
    return invariantResult(invariant, 'REJECTED', 'node_kind_mismatch',
      `Target resolved to ${target.node.kind}, not a function-like node.`,
      target.provenance);
  }
  if (invariant.async !== undefined && isAsyncNode(target.node) !== invariant.async) {
    return invariantResult(invariant, 'REJECTED', 'function_async_mismatch',
      `Function async shape does not match expected ${String(invariant.async)}.`,
      target.provenance);
  }
  if (
    invariant.returnAnnotation !== undefined &&
    !hasReturnAnnotation(target.node, invariant.returnAnnotation)
  ) {
    return invariantResult(invariant, 'REJECTED', 'function_return_mismatch',
      `Function return annotation "${invariant.returnAnnotation}" is missing.`,
      target.provenance);
  }
  return invariantResult(invariant, 'PROVED', 'proved',
    'Function shape invariant is proved.', target.provenance);
}

function abortError(signal: AbortSignal): Error {
  const reason = signal.reason;
  if (reason instanceof Error) return reason;
  return new DOMException('This operation was aborted', 'AbortError');
}
