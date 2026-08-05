/** Failed-audit subject derivation for dependency-impact analysis. */

import type {
  DependencyImpactFileFallbackReason,
  DependencyImpactSubject,
} from '../contracts/dependencyImpact.js';
import type { AuditResult, AuditViolation } from '../contracts/audit.js';
import type { WritableManifest } from '../contracts/manifest.js';

export function deriveRepairSubjects(
  manifest: WritableManifest,
  auditResult: AuditResult,
): DependencyImpactSubject[] {
  const subjects: DependencyImpactSubject[] = [];
  const seenSymbols = new Set<string>();
  const seenFiles = new Set<string>();

  const emitSymbol = (
    path: string,
    symbolName: string,
    symbolKind: string,
    byteRange: readonly [number, number],
    changeMode: 'modified' | 'added' | 'removed',
    origin: 'audit_violation' | 'manifest_scope',
  ) => {
    const key = `${path}::${symbolName}`;
    if (seenSymbols.has(key)) return;
    seenSymbols.add(key);
    subjects.push({
      kind: 'symbol',
      path,
      symbolName,
      symbolKind,
      byteRange: [byteRange[0], byteRange[1]],
      changeMode,
      origin,
    });
  };

  const emitFile = (
    path: string,
    reason: DependencyImpactFileFallbackReason,
    origin: 'audit_violation' | 'manifest_scope',
  ) => {
    const key = `${path}::${reason}::${origin}`;
    if (seenFiles.has(key)) return;
    seenFiles.add(key);
    subjects.push({
      kind: 'file',
      path,
      origin,
      reason,
    });
  };

  // 1. Contracted intent from the manifest — what the host asked for.
  for (const entry of manifest.entries) {
    if (entry.scope.kind === 'whole_file') {
      emitFile(entry.path, 'whole_file_manifest_scope', 'manifest_scope');
      continue;
    }
    for (const symbolName of entry.scope.symbols) {
      emitSymbol(
        entry.path,
        symbolName,
        'symbol',
        [0, 0],
        'modified',
        'manifest_scope',
      );
    }
  }

  // 2. Authoritative violations from the failed audit — what actually went wrong.
  if (auditResult.status === 'BLOCK') {
    for (const violation of auditResult.violations) {
      appendRepairSubjectsFromViolation(violation, emitSymbol, emitFile);
    }
  }

  return subjects;
}

function appendRepairSubjectsFromViolation(
  violation: AuditViolation,
  emitSymbol: (
    path: string,
    symbolName: string,
    symbolKind: string,
    byteRange: readonly [number, number],
    changeMode: 'modified' | 'added' | 'removed',
    origin: 'audit_violation' | 'manifest_scope',
  ) => void,
  emitFile: (
    path: string,
    reason: DependencyImpactFileFallbackReason,
    origin: 'audit_violation' | 'manifest_scope',
  ) => void,
): void {
  switch (violation.kind) {
    case 'out_of_scope_symbol':
      emitSymbol(
        violation.path,
        violation.symbolName,
        violation.nodeKind,
        violation.byteRange,
        'added',
        'audit_violation',
      );
      return;
    case 'uncontracted_file':
      emitFile(violation.path, 'uncontracted_file', 'audit_violation');
      return;
    case 'parse_failure':
      emitFile(violation.path, 'parse_failure_violation', 'audit_violation');
      return;
    case 'snapshot_missing':
      // Whole-audit-class failure — no specific file/symbol target.
      return;
    case 'SCOPE_ESCAPE':
      emitSymbol(
        violation.path,
        violation.escapingNodeKind,
        violation.escapingNodeKind,
        violation.byteRange,
        'modified',
        'audit_violation',
      );
      return;
    case 'STRUCTURAL_CORRUPTION':
      emitFile(violation.path, 'parse_failure_violation', 'audit_violation');
      return;
    case 'PATH_ESCAPE':
      emitFile(violation.path, 'uncontracted_file', 'audit_violation');
      return;
    case 'SIGNATURE_MISMATCH':
    case 'SIGNATURE_UNCERTAIN':
      emitSymbol(
        violation.path,
        violation.symbol,
        'signature',
        [0, 0],
        'modified',
        'audit_violation',
      );
      return;
    case 'TARGET_NOT_FOUND':
      emitSymbol(
        violation.path,
        violation.symbolName,
        'symbol',
        [0, 0],
        'modified',
        'audit_violation',
      );
      return;
    case 'DUPLICATE_TARGET':
      emitSymbol(
        violation.path,
        violation.symbolName,
        'symbol',
        violation.existingByteRange,
        'added',
        'audit_violation',
      );
      return;
    case 'IMPORT_TARGET_NOT_FOUND':
    case 'IMPORT_ALIAS_UNRESOLVED':
      emitFile(violation.path, 'uncontracted_file', 'audit_violation');
      return;
    case 'IMPORT_SYMBOL_NOT_EXPORTED':
      emitSymbol(
        violation.path,
        violation.symbol,
        'import',
        [0, 0],
        'modified',
        'audit_violation',
      );
      return;
    default: {
      // Exhaustive handling — if a new AuditViolation kind is added without
      // updating this switch the TypeScript check will surface it here.
      const _unhandled: never = violation;
      void _unhandled;
      return;
    }
  }
}
