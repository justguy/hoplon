/**
 * launcher/queryHuman.ts — human-readable renderer for `hoplon query` envelopes.
 *
 * Split from query.ts so the dispatcher file stays under the 300-line
 * architecture cap. Consumed only by the CLI path; the JSON envelope stays
 * the canonical machine-readable output.
 */

import type { DescribeCapabilitiesResult } from '../contracts/capabilities.js';
import type { StructuralTemplate } from '../contracts/structuralTemplate.js';
import type { QueryStructureResult } from '../contracts/queryStructure.js';
import type { SearchSymbolsResult } from '../contracts/searchSymbols.js';
import type { DescribeProjectResult } from '../contracts/describeProject.js';
import type { QueryEnvelope } from './query.js';

export function renderQueryHuman(envelope: QueryEnvelope<unknown>): string {
  const lines: string[] = [];
  lines.push(
    `${envelope.command} — ${envelope.ok ? 'ok' : 'error'} (engineId=${envelope.engineId})`,
  );
  if (!envelope.ok && envelope.error) {
    lines.push(`  error: ${envelope.error.kind}: ${envelope.error.message}`);
    return lines.join('\n');
  }
  if (envelope.command === 'query capabilities') {
    const data = envelope.data as DescribeCapabilitiesResult;
    for (const cap of data.capabilities) {
      lines.push(
        `  ${cap.descriptor.capabilityId.padEnd(28)} ${cap.descriptor.runtimeState}`,
      );
    }
    return lines.join('\n');
  }
  if (envelope.command === 'query skeleton') {
    const data = envelope.data as StructuralTemplate;
    lines.push(`  snapshotRef: ${data.snapshotRef ?? '(live filesystem)'}`);
    for (const file of data.files) {
      lines.push(`  ${file.path}`);
      lines.push(
        `    exports: ${file.exports.length}, imports: ${file.imports.length}, types: ${file.types.length}`,
      );
    }
    return lines.join('\n');
  }
  if (envelope.command === 'query structure') {
    const data = envelope.data as QueryStructureResult;
    lines.push(`  matches: ${data.matches.length}, failures: ${data.failures.length}`);
    return lines.join('\n');
  }
  if (envelope.command === 'query search') {
    const data = envelope.data as SearchSymbolsResult;
    lines.push(
      `  matches: ${data.matches.length}, filesScanned: ${data.filesScanned}, truncated: ${data.truncated}`,
    );
    if (data.failures.length > 0) {
      lines.push(`  failures: ${data.failures.length}`);
    }
    const preview = data.matches.slice(0, 10);
    for (const m of preview) {
      lines.push(`  ${m.kind.padEnd(9)} ${m.name}  (${m.path})`);
    }
    if (data.matches.length > preview.length) {
      lines.push(`  … (${data.matches.length - preview.length} more)`);
    }
    return lines.join('\n');
  }
  if (envelope.command === 'query project') {
    const data = envelope.data as DescribeProjectResult;
    lines.push(
      `  files: ${data.files.total} (scanned ${data.filesScanned}${data.truncated ? ', truncated' : ''})`,
    );
    if (data.failures.length > 0) {
      lines.push(`  failures: ${data.failures.length}`);
    }
    for (const lang of data.files.byLanguage) {
      lines.push(`    ${lang.language.padEnd(12)} ${lang.fileCount}`);
    }
    lines.push(
      `  symbols: functions=${data.symbols.functions}, classes=${data.symbols.classes}, ` +
        `types=${data.symbols.types}, exports=${data.symbols.exports}, imports=${data.symbols.imports}`,
    );
    return lines.join('\n');
  }
  return lines.join('\n');
}
