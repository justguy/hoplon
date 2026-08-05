export interface AuditMetrics {
  astNodeCount: number | null;
  fileLineCount: number | null;
  manifestScopeRatio: number | null;
}

export interface AuditMetricState {
  totalAstNodes: number;
  totalLineCount: number;
  totalFileBytes: number;
  scopeCoveredBytes: number;
  anyFileRead: boolean;
  anyFileParsed: boolean;
}

export function createAuditMetricState(): AuditMetricState {
  return {
    totalAstNodes: 0,
    totalLineCount: 0,
    totalFileBytes: 0,
    scopeCoveredBytes: 0,
    anyFileRead: false,
    anyFileParsed: false,
  };
}

export function recordAuditFileRead(
  state: AuditMetricState,
  content: Uint8Array,
  wholeFileScope: boolean,
): void {
  state.anyFileRead = true;
  state.totalFileBytes += content.byteLength;
  let newlineCount = 0;
  for (let index = 0; index < content.byteLength; index++) {
    if (content[index] === 0x0a) newlineCount++;
  }
  state.totalLineCount += content.byteLength === 0 ? 0 : newlineCount + 1;
  if (wholeFileScope) state.scopeCoveredBytes += content.byteLength;
}

export function recordAuditTree(
  state: AuditMetricState,
  root: { kind: string; children: unknown[] },
): void {
  state.anyFileParsed = true;
  state.totalAstNodes += countAstNodes(root);
}

export function finalizeAuditMetrics(state: AuditMetricState): AuditMetrics {
  return {
    astNodeCount: state.anyFileParsed ? state.totalAstNodes : null,
    fileLineCount: state.anyFileRead ? state.totalLineCount : null,
    manifestScopeRatio:
      state.anyFileRead && state.totalFileBytes > 0
        ? state.scopeCoveredBytes / state.totalFileBytes
        : null,
  };
}

function countAstNodes(root: { kind: string; children: unknown[] }): number {
  let count = 0;
  const stack: Array<{ kind: string; children: unknown[] }> = [root];
  while (stack.length > 0) {
    const node = stack.pop()!;
    count++;
    if (!Array.isArray(node.children)) continue;
    for (const child of node.children) {
      if (
        child !== null &&
        typeof child === 'object' &&
        'kind' in child &&
        'children' in child
      ) {
        stack.push(child as { kind: string; children: unknown[] });
      }
    }
  }
  return count;
}
