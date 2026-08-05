export function deriveStrictCapabilityAstScope(
  method: string,
  raw: Record<string, unknown>,
): { astNodeIds: string[]; astSelectors: string[] } {
  if (method !== 'seeCodebase' || !Array.isArray(raw['targets'])) {
    return { astNodeIds: [], astSelectors: [] };
  }
  const astNodeIds: string[] = [];
  const astSelectors: string[] = [];
  for (const target of raw['targets']) {
    if (typeof target !== 'object' || target === null) continue;
    const value = target as Record<string, unknown>;
    if (value['kind'] !== 'ast_node') continue;
    const expected = value['expectedIdentity'];
    const stableId =
      typeof expected === 'object' && expected !== null
        ? stringValue((expected as Record<string, unknown>)['stableId'])
        : null;
    if (stableId !== null) {
      astNodeIds.push(stableId);
      continue;
    }
    const selector = strictCapabilityAstSelector(value['selector']);
    if (selector !== null) astSelectors.push(selector);
  }
  return { astNodeIds: dedupe(astNodeIds), astSelectors: dedupe(astSelectors) };
}

/** Canonical capability coordinate for an actual `ast_node` dispatch target. */
export function strictCapabilityAstSelector(selector: unknown): string | null {
  if (typeof selector !== 'object' || selector === null) return null;
  const value = selector as Record<string, unknown>;
  if (value['kind'] === 'symbol') {
    const name = stringValue(value['name']);
    return name === null ? null : `symbol:${JSON.stringify(name)}`;
  }
  if (value['kind'] !== 'symbol_path' || !Array.isArray(value['symbolPath'])) {
    return null;
  }
  const path = value['symbolPath'];
  if (!path.every((part) => typeof part === 'string' && part.length > 0)) {
    return null;
  }
  return `symbol_path:${JSON.stringify(path)}`;
}

const stringValue = (value: unknown): string | null =>
  typeof value === 'string' && value.length > 0 ? value : null;

const dedupe = (values: readonly string[]): string[] => [...new Set(values)];
