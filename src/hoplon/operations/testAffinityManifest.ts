import type { HoplonFsAdapter } from '../adapters/fs.js';
import {
  TestAffinityManifestSchema,
  type TestAffinityEntry,
  type TestAffinityIssue,
} from '../contracts/testAffinity.js';

const MANUAL_MANIFEST = '.hoplon/test-affinity.json';
const GENERATED_MANIFEST = '.hoplon/test-affinity.generated.json';

export interface TestAffinityLoadResult {
  entries: TestAffinityEntry[];
  issues: TestAffinityIssue[];
}

export async function loadTestAffinityManifests(
  fs: HoplonFsAdapter,
): Promise<TestAffinityLoadResult> {
  const manual = await loadOne(fs, MANUAL_MANIFEST);
  const generated = await loadOne(fs, GENERATED_MANIFEST);
  return {
    entries: [...manual.entries, ...generated.entries].sort((a, b) =>
      a.id.localeCompare(b.id),
    ),
    issues: [...manual.issues, ...generated.issues].sort((a, b) =>
      `${a.manifestPath}:${a.kind}:${a.message}`.localeCompare(
        `${b.manifestPath}:${b.kind}:${b.message}`,
      ),
    ),
  };
}

async function loadOne(
  fs: HoplonFsAdapter,
  manifestPath: string,
): Promise<TestAffinityLoadResult> {
  const stat = await fs.stat(manifestPath);
  if (!stat.exists) {
    return {
      entries: [],
      issues: [{
        manifestPath,
        kind: 'missing',
        message: 'test-affinity manifest is absent',
      }],
    };
  }
  let parsedJson: unknown;
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(
      await fs.read(manifestPath),
    );
    parsedJson = JSON.parse(text);
  } catch (err) {
    return {
      entries: [],
      issues: [{
        manifestPath,
        kind: 'invalid_json',
        message: err instanceof Error ? err.message : String(err),
      }],
    };
  }
  const parsed = TestAffinityManifestSchema.safeParse(parsedJson);
  if (!parsed.success) {
    return {
      entries: [],
      issues: [{
        manifestPath,
        kind: 'invalid_manifest',
        message: parsed.error.message,
      }],
    };
  }
  const expectedSource = manifestPath === MANUAL_MANIFEST ? 'manual' : 'generated';
  const entries: TestAffinityEntry[] = [];
  const issues: TestAffinityIssue[] = [];
  for (const entry of parsed.data.entries) {
    if (entry.source !== expectedSource) {
      issues.push({
        manifestPath,
        kind: 'invalid_entry',
        message: `entry ${entry.id} source must be ${expectedSource}`,
      });
      continue;
    }
    entries.push(entry);
  }
  return { entries, issues };
}
