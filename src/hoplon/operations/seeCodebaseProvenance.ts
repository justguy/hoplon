import type { SeeCodebaseReadProvenance } from '../contracts/seeCodebase.js';

export function liveFsProvenance(
  workspaceRoot: string,
  filePath?: string,
): SeeCodebaseReadProvenance {
  return {
    kind: 'live_filesystem',
    workspaceRoot,
    ...(typeof filePath === 'string' ? { filePath } : {}),
    readAtIso: new Date().toISOString(),
  };
}
