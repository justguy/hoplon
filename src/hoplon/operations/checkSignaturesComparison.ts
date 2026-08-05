import type { SyntaxTree } from '../adapters/codeIntelligence.js';
import type { AuditViolation } from '../contracts/audit.js';
import type { SignatureContract } from '../contracts/manifest.js';
import {
  extractParamNodes,
  findFunctionNodes,
  hasTypeParameters,
  parseParamNode,
  stringifyActualParams,
  stringifyExpectedParams,
} from './checkSignaturesAst.js';
import type { SignatureNode } from './checkSignaturesAst.js';

export function checkContractAgainstTree(
  contract: SignatureContract,
  tree: SyntaxTree,
  _content: string,
  filePath: string,
): AuditViolation | null {
  const root = tree.rootNode as unknown as SignatureNode;
  const functionNodes = findFunctionNodes(root, contract.symbol);
  if (functionNodes.length === 0) return null;

  if (functionNodes.length > 1) {
    return {
      kind: 'SIGNATURE_UNCERTAIN',
      path: filePath,
      symbol: contract.symbol,
      note: `Multiple declarations of "${contract.symbol}" found — overload comparison requires ts-morph (deferred to Phase 3).`,
      message: `Signature of "${contract.symbol}" in ${filePath} could not be verified: multiple overload declarations found.`,
      correction: `Ensure "${contract.symbol}" has a single non-overloaded signature, or wait for Phase 3 ts-morph verification.`,
    };
  }

  const functionNode = functionNodes[0]!;
  if (hasTypeParameters(functionNode)) {
    return {
      kind: 'SIGNATURE_UNCERTAIN',
      path: filePath,
      symbol: contract.symbol,
      note: `"${contract.symbol}" uses type parameters — generic comparison requires ts-morph (deferred to Phase 3).`,
      message: `Signature of "${contract.symbol}" in ${filePath} could not be verified: generic type parameters present.`,
      correction: `Ensure "${contract.symbol}" has a non-generic signature, or wait for Phase 3 ts-morph verification.`,
    };
  }

  const paramNodes = extractParamNodes(functionNode);
  if (paramNodes === null) {
    return {
      kind: 'SIGNATURE_UNCERTAIN',
      path: filePath,
      symbol: contract.symbol,
      note: `Could not extract formal_parameters from "${contract.symbol}" — complex parameter syntax requires ts-morph.`,
      message: `Signature of "${contract.symbol}" in ${filePath} could not be verified: parameter extraction failed.`,
      correction: `Simplify the signature of "${contract.symbol}", or wait for Phase 3 ts-morph verification.`,
    };
  }

  for (const param of paramNodes) {
    const parsed = parseParamNode(param);
    if (parsed === null) {
      return {
        kind: 'SIGNATURE_UNCERTAIN',
        path: filePath,
        symbol: contract.symbol,
        note: `Parameter "${param.text}" of "${contract.symbol}" uses destructuring or complex syntax — comparison requires ts-morph.`,
        message: `Signature of "${contract.symbol}" in ${filePath} could not be verified: destructured parameter.`,
        correction: `Simplify the parameters of "${contract.symbol}", or wait for Phase 3 ts-morph verification.`,
      };
    }
    if (parsed.hasGeneric) {
      return {
        kind: 'SIGNATURE_UNCERTAIN',
        path: filePath,
        symbol: contract.symbol,
        note: `Parameter "${parsed.name}: ${parsed.typeText}" of "${contract.symbol}" uses a generic type — comparison requires ts-morph.`,
        message: `Signature of "${contract.symbol}" in ${filePath} could not be verified: generic parameter type.`,
        correction: `Simplify the parameters of "${contract.symbol}", or wait for Phase 3 ts-morph verification.`,
      };
    }
  }

  if (paramNodes.length !== contract.expectedParams.length) {
    const expected = stringifyExpectedParams(contract.expectedParams);
    const actual = stringifyActualParams(paramNodes);
    return {
      kind: 'SIGNATURE_MISMATCH',
      path: filePath,
      symbol: contract.symbol,
      expected: `(${expected}): ${contract.expectedReturn}`,
      actual: `(${actual})`,
      message: `Signature of "${contract.symbol}" in ${filePath} has ${paramNodes.length} parameter(s) but the contract declares ${contract.expectedParams.length}.`,
      correction: `Update "${contract.symbol}" to match the declared signature: (${expected}): ${contract.expectedReturn}.`,
    };
  }

  for (let index = 0; index < contract.expectedParams.length; index++) {
    const expected = contract.expectedParams[index]!;
    const parsed = parseParamNode(paramNodes[index]!);
    if (
      parsed !== null &&
      expected.type.length > 0 &&
      parsed.typeText.length > 0 &&
      parsed.typeText !== expected.type
    ) {
      const expectedText = stringifyExpectedParams(contract.expectedParams);
      const actualText = stringifyActualParams(paramNodes);
      return {
        kind: 'SIGNATURE_MISMATCH',
        path: filePath,
        symbol: contract.symbol,
        expected: `(${expectedText}): ${contract.expectedReturn}`,
        actual: `(${actualText})`,
        message: `Parameter "${parsed.name}" of "${contract.symbol}" in ${filePath} has type "${parsed.typeText}" but the contract declares "${expected.type}".`,
        correction: `Update "${contract.symbol}" to match the declared signature: (${expectedText}): ${contract.expectedReturn}.`,
      };
    }
  }

  return null;
}
