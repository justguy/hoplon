/**
 * LC3 syntactic signature compliance verification.
 *
 * The operation is pure apart from the injected parser. Generic, overloaded,
 * or otherwise ambiguous syntax remains advisory (`SIGNATURE_UNCERTAIN`);
 * definite parameter-count and parameter-type mismatches block.
 */

import type {
  CodeIntelligenceAdapter,
  SyntaxTree,
} from '../adapters/codeIntelligence.js';
import type { AuditViolation } from '../contracts/audit.js';
import type { SignatureContract } from '../contracts/manifest.js';
import { checkContractAgainstTree } from './checkSignaturesComparison.js';

export type SignatureCheckStatus = 'PASS' | 'BLOCK' | 'UNCERTAIN';

export interface SignatureCheckResult {
  status: SignatureCheckStatus;
  violations: AuditViolation[];
}

export interface CheckSignaturesDeps {
  codeIntelligence: CodeIntelligenceAdapter;
}

/** Verify proposed changes against the manifest's signature contracts. */
export async function checkSignatures(
  deps: CheckSignaturesDeps,
  changes: ReadonlyArray<{ file: string; content: string }>,
  contracts: ReadonlyArray<SignatureContract> | undefined,
  signal?: AbortSignal,
): Promise<SignatureCheckResult> {
  if (!contracts || contracts.length === 0) {
    return { status: 'PASS', violations: [] };
  }

  const violations: AuditViolation[] = [];
  const changeMap = new Map<string, string>();
  for (const change of changes) {
    changeMap.set(change.file, change.content);
  }

  for (const contract of contracts) {
    if (signal?.aborted) break;
    const content = changeMap.get(contract.file);
    if (content === undefined) continue;

    let tree: SyntaxTree;
    try {
      tree = await deps.codeIntelligence.parse(
        contract.file,
        new Uint8Array(Buffer.from(content, 'utf8')),
        signal,
      );
    } catch {
      continue;
    }

    const violation = checkContractAgainstTree(
      contract,
      tree,
      content,
      contract.file,
    );
    if (violation !== null) violations.push(violation);
  }

  if (violations.length === 0) return { status: 'PASS', violations: [] };
  const hasHardViolation = violations.some(
    (violation) => violation.kind === 'SIGNATURE_MISMATCH',
  );
  return {
    status: hasHardViolation ? 'BLOCK' : 'UNCERTAIN',
    violations,
  };
}
