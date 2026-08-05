/**
 * operations/interfaceStubDeclarations.ts — declaration-aware rendering helpers
 * for t-028 interface stubs.
 *
 * Uses the already-shipped TypeScript compiler API to build and print
 * declaration ASTs. This satisfies the tracker brief's
 * "ts-morph or equivalent declaration-aware generation" bar without adding a
 * new dependency to core.
 */

import ts = require('typescript');

import { ValidationError } from '../contracts/errors.js';
import type { SignatureContract } from '../contracts/manifest.js';

const PRINTER = ts.createPrinter({
  newLine: ts.NewLineKind.LineFeed,
  removeComments: false,
});

export function renderAuthoritativeDeclaration(
  engineId: string,
  correlationId: string,
  symbol: string,
  contracts: readonly SignatureContract[],
): string {
  const name = assertIdentifierText(engineId, correlationId, symbol, 'target symbol');
  const statements = contracts.map((contract) =>
    ts.factory.createFunctionDeclaration(
      exportDeclareModifiers(),
      undefined,
      name,
      undefined,
      contract.expectedParams.map((param) =>
        ts.factory.createParameterDeclaration(
          undefined,
          undefined,
          assertIdentifierText(engineId, correlationId, param.name, 'parameter name'),
          param.optional === true
            ? ts.factory.createToken(ts.SyntaxKind.QuestionToken)
            : undefined,
          parseTypeNode(engineId, correlationId, param.type, 'parameter type'),
          undefined,
        ),
      ),
      parseTypeNode(engineId, correlationId, contract.expectedReturn, 'return type'),
      undefined,
    ),
  );

  return printStatements(statements);
}

export function renderPlaceholderDeclaration(
  engineId: string,
  correlationId: string,
  symbol: string,
): string {
  const name = assertIdentifierText(engineId, correlationId, symbol, 'target symbol');
  return printStatements([
    ts.factory.createVariableStatement(
      exportDeclareModifiers(),
      ts.factory.createVariableDeclarationList(
        [
          ts.factory.createVariableDeclaration(
            name,
            undefined,
            ts.factory.createKeywordTypeNode(ts.SyntaxKind.UnknownKeyword),
            undefined,
          ),
        ],
        ts.NodeFlags.Const,
      ),
    ),
  ]);
}

function exportDeclareModifiers(): ts.Modifier[] {
  return [
    ts.factory.createModifier(ts.SyntaxKind.ExportKeyword),
    ts.factory.createModifier(ts.SyntaxKind.DeclareKeyword),
  ];
}

function printStatements(statements: readonly ts.Statement[]): string {
  const sourceFile = ts.factory.createSourceFile(
    [...statements],
    ts.factory.createToken(ts.SyntaxKind.EndOfFileToken),
    ts.NodeFlags.None,
  );
  return PRINTER.printFile(sourceFile).trim();
}

function parseTypeNode(
  engineId: string,
  correlationId: string,
  typeText: string,
  fieldName: 'parameter type' | 'return type',
): ts.TypeNode {
  const sourceFile = ts.createSourceFile(
    'hoplon-interface-stub.ts',
    `type __Hoplon = ${typeText};`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const alias = sourceFile.statements[0];
  const diagnostics = getParseDiagnostics(sourceFile);

  if (alias === undefined || !ts.isTypeAliasDeclaration(alias) || diagnostics.length > 0) {
    throw new ValidationError(
      {
        kind: 'invalid_manifest',
        engineId,
        correlationId,
        cause: diagnostics,
      },
      `synthesizeInterfaceStubs: invalid ${fieldName} syntax: ${typeText}`,
    );
  }

  return alias.type;
}

function assertIdentifierText(
  engineId: string,
  correlationId: string,
  text: string,
  fieldName: 'target symbol' | 'parameter name',
): string {
  const sourceFile = ts.createSourceFile(
    'hoplon-interface-identifier.ts',
    `const ${text} = 1;`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const diagnostics = getParseDiagnostics(sourceFile);
  const statement = sourceFile.statements[0];
  const declaration =
    statement !== undefined && ts.isVariableStatement(statement)
      ? statement.declarationList.declarations[0]
      : undefined;

  if (
    diagnostics.length === 0 &&
    declaration !== undefined &&
    ts.isIdentifier(declaration.name) &&
    declaration.name.text === text
  ) {
    return text;
  }

  throw new ValidationError(
    {
      kind: 'invalid_manifest',
      engineId,
      correlationId,
    },
    `synthesizeInterfaceStubs: invalid ${fieldName}: ${text}`,
  );
}

function getParseDiagnostics(
  sourceFile: ts.SourceFile,
): readonly ts.DiagnosticWithLocation[] {
  return (
    sourceFile as ts.SourceFile & {
      parseDiagnostics?: readonly ts.DiagnosticWithLocation[];
    }
  ).parseDiagnostics ?? [];
}
