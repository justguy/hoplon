import type {
  ManifestEntry,
  WritableManifest,
} from '../contracts/manifest.js';

function describeEntry(entry: ManifestEntry): string {
  if (entry.scope.kind === 'whole_file') {
    if (entry.intent === 'create') {
      return `Create file: ${entry.path}.`;
    }
    if (entry.intent === 'modify') {
      return `Modify only file: ${entry.path}.`;
    }
    return `Change only file: ${entry.path}.`;
  }

  const symbols = entry.scope.symbols.join(', ');
  if (entry.intent === 'create') {
    return `Create symbol(s): ${symbols} in ${entry.path}.`;
  }
  if (entry.intent === 'modify') {
    return `Modify only symbol(s): ${symbols} in ${entry.path}.`;
  }
  return `Change only symbol(s): ${symbols} in ${entry.path}.`;
}

export function deriveContractedChangesMap(
  manifest: WritableManifest,
  files: readonly string[],
): Record<string, string> {
  const entriesByPath = new Map<string, ManifestEntry[]>();
  for (const entry of manifest.entries) {
    const existing = entriesByPath.get(entry.path);
    if (existing) {
      existing.push(entry);
    } else {
      entriesByPath.set(entry.path, [entry]);
    }
  }

  const descriptions: Record<string, string> = {};
  for (const file of files) {
    if (file in descriptions) continue;
    const entries = entriesByPath.get(file);
    if (!entries || entries.length === 0) {
      descriptions[file] =
        `No contracted change is allowed in ${file}; keep the file unchanged and move the edit to a manifest-declared target.`;
      continue;
    }
    descriptions[file] = entries.map(describeEntry).join(' ');
  }
  return descriptions;
}
