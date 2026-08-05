export interface StrictCapabilityDerivedCase {
  readonly name: string;
  readonly resolvedBranch: string;
  readonly target: Record<string, unknown>;
  readonly claimAstNodeIds?: readonly string[];
  readonly claimAstSelectors?: readonly string[];
  readonly declaredCapability?: Record<string, unknown>;
  readonly expectedStatus: 200 | 401 | 403;
  readonly shouldDispatch: boolean;
}

/**
 * Repo-native allow/deny corpus for the existing opt-in strict capability gate.
 * The request target drives dispatch; the separate capability payload never
 * supplies trusted branch or AST facts.
 */
export const STRICT_CAPABILITY_DERIVED_CORPUS: readonly StrictCapabilityDerivedCase[] = [
  {
    name: 'allows a matching server branch and target stable identity',
    resolvedBranch: 'main',
    target: {
      kind: 'ast_node',
      file: 'src/foo.ts',
      selector: { kind: 'symbol', name: 'foo' },
      expectedIdentity: { stableId: 'node-foo' },
    },
    claimAstNodeIds: ['node-foo'],
    expectedStatus: 200,
    shouldDispatch: true,
  },
  {
    name: 'allows a matching canonical selector when no stable identity is supplied',
    resolvedBranch: 'main',
    target: {
      kind: 'ast_node',
      file: 'src/foo.ts',
      selector: { kind: 'symbol', name: 'foo' },
    },
    claimAstSelectors: ['symbol:"foo"'],
    expectedStatus: 200,
    shouldDispatch: true,
  },
  {
    name: 'denies a server-resolved branch outside the token claim',
    resolvedBranch: 'feature/other',
    target: { kind: 'file', path: 'src/foo.ts' },
    expectedStatus: 403,
    shouldDispatch: false,
  },
  {
    name: 'denies a dispatched stable identity outside the token claim',
    resolvedBranch: 'main',
    target: {
      kind: 'ast_node',
      file: 'src/foo.ts',
      selector: { kind: 'symbol', name: 'foo' },
      expectedIdentity: { stableId: 'node-other' },
    },
    claimAstNodeIds: ['node-foo'],
    expectedStatus: 403,
    shouldDispatch: false,
  },
  {
    name: 'caller AST fields cannot attest a non-AST dispatch target',
    resolvedBranch: 'main',
    target: { kind: 'file', path: 'src/foo.ts' },
    claimAstNodeIds: ['node-foo'],
    declaredCapability: {
      key: 'read',
      branch: 'main',
      path: 'src/foo.ts',
      astNodeIds: ['node-foo'],
    },
    expectedStatus: 403,
    shouldDispatch: false,
  },
  {
    name: 'caller branch cannot override the server-resolved branch',
    resolvedBranch: 'main',
    target: { kind: 'file', path: 'src/foo.ts' },
    declaredCapability: {
      key: 'read',
      branch: 'feature/lie',
      path: 'src/foo.ts',
    },
    expectedStatus: 403,
    shouldDispatch: false,
  },
];
