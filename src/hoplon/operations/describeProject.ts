/**
 * operations/describeProject.ts — t-056 local AST-aware project orientation.
 *
 * Walks the project tree, classifies JS/TS files by tree-sitter grammar, and
 * runs a structural-counts pass over the first `maxFiles` files (alphabetical
 * order) so callers can orient without reading every file.
 *
 * ## What this is — and what this is not
 *   - This answers "what languages live here? roughly how many functions /
 *     classes / type declarations?". It is the read-only orientation
 *     companion to `searchSymbols`.
 *   - It is NOT a code-complexity, dependency-graph, or quality report.
 *   - It does not parse files outside the JS/TS supported set. Other
 *     languages still appear in the file count if they are present, but they
 *     never reach tree-sitter because no grammar exists for them in Phase 1.
 *     (In practice the underlying file-collector already restricts to
 *     JS/TS extensions, so the file count reflects JS/TS only.)
 *
 * ## Determinism (H7)
 *   File walk sorted alphabetically; per-language sample paths sorted;
 *   counts are exact for the successfully parsed portion of the sampled
 *   files, never sampled-then-extrapolated. Failures are surfaced explicitly.
 *
 * ## Path safety (H9), H13, H15
 *   See header on searchSymbols.ts — same posture, same delegated enforcement
 *   via queryStructure / canonicalizePath.
 */

import type { HoplonFsAdapter } from '../adapters/fs.js';
import type { CodeIntelligenceAdapter } from '../adapters/codeIntelligence.js';
import type { HoplonEmitter } from '../adapters/emitter.js';
import {
  DescribeProjectRequestSchema,
  type DescribeProjectRequest,
  type DescribeProjectResult,
  type ProjectLanguage,
  SUPPORTED_PROJECT_LANGUAGES,
} from '../contracts/describeProject.js';
import type { TreeSitterQuery } from '../contracts/queryStructure.js';
import { ValidationError } from '../contracts/errors.js';
import { validateCorrelationId, validateRunId } from '../util/validators.js';
import { detectLanguage } from '../adapters/codeIntelligence/treeSitter.js';
import { queryStructure } from './queryStructure.js';
import type { QueryStructureDeps } from './queryStructure.js';
import {
  STD_QUERY_FUNCTION_SIGNATURES,
  STD_QUERY_EXPORTS,
  STD_QUERY_IMPORTS,
} from './stdQueries.js';
import { collectFiles } from './getRelevantTestsInternal.js';

// ---------------------------------------------------------------------------
// Public interface
// ---------------------------------------------------------------------------

export interface DescribeProjectDeps {
  fs: HoplonFsAdapter;
  codeIntelligence: CodeIntelligenceAdapter;
  emitter: HoplonEmitter;
  engineId: string;
  root: string;
  config: { maxFileBytes: number; parseTimeoutMs: number };
}

// Local class-declaration queries — same shapes as searchSymbols but kept
// here to avoid coupling describeProject to that module's internals.
const CLASS_DECL_QUERIES: readonly TreeSitterQuery[] = [
  {
    id: 'project-class-decl',
    language: 'javascript',
    pattern: `(class_declaration name: (identifier) @class_name)`,
  },
  {
    id: 'project-class-decl',
    language: 'typescript',
    pattern: `(class_declaration name: (type_identifier) @class_name)`,
  },
  {
    id: 'project-class-decl',
    language: 'tsx',
    pattern: `(class_declaration name: (type_identifier) @class_name)`,
  },
];

const TYPE_QUERIES: readonly TreeSitterQuery[] = [
  {
    id: 'project-type-decl',
    language: 'typescript',
    pattern: `(interface_declaration name: (type_identifier) @type_name)`,
  },
  {
    id: 'project-type-decl',
    language: 'typescript',
    pattern: `(type_alias_declaration name: (type_identifier) @type_name)`,
  },
  {
    id: 'project-type-decl',
    language: 'tsx',
    pattern: `(interface_declaration name: (type_identifier) @type_name)`,
  },
  {
    id: 'project-type-decl',
    language: 'tsx',
    pattern: `(type_alias_declaration name: (type_identifier) @type_name)`,
  },
];

// ---------------------------------------------------------------------------
// describeProject — main entry point
// ---------------------------------------------------------------------------

export async function describeProject(
  deps: DescribeProjectDeps,
  req: DescribeProjectRequest,
  signal?: AbortSignal,
): Promise<DescribeProjectResult> {
  const { fs, codeIntelligence, emitter, engineId, root, config } = deps;
  const startMs = Date.now();

  const parseResult = DescribeProjectRequestSchema.safeParse(req);
  if (!parseResult.success) {
    const corrId =
      typeof (req as { correlationId?: unknown })?.correlationId === 'string' &&
      ((req as { correlationId?: string }).correlationId ?? '').length > 0
        ? (req as { correlationId: string }).correlationId
        : 'validator';
    throw new ValidationError(
      { kind: 'invalid_manifest', engineId, correlationId: corrId, cause: parseResult.error },
      `describeProject: invalid request: ${parseResult.error.message}`,
    );
  }
  const validated = parseResult.data;

  validateCorrelationId(validated.correlationId);
  validateRunId(validated.runId);

  emitter.emit({
    op: 'describeProject',
    phase: 'start',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
  });

  let result: DescribeProjectResult;
  try {
    const allFiles = (await collectFiles(fs, '.')).sort();
    const total = allFiles.length;

    // Group every discovered file by detected language (Phase 1 supported set).
    const byLang = new Map<ProjectLanguage, string[]>();
    for (const lang of SUPPORTED_PROJECT_LANGUAGES) byLang.set(lang, []);
    for (const f of allFiles) {
      const lang = detectLanguage(f);
      if (lang === null) continue;
      const list = byLang.get(lang);
      if (list) list.push(f);
    }

    const sampleSize = validated.samplePathsPerLanguage;
    const byLanguage = SUPPORTED_PROJECT_LANGUAGES.map((lang) => {
      const list = byLang.get(lang) ?? [];
      return {
        language: lang,
        fileCount: list.length,
        samplePaths: list.slice(0, sampleSize),
      };
    });

    const sample = allFiles.slice(0, validated.maxFiles);
    const truncated = total > sample.length;

    let exports = 0;
    let imports = 0;
    let types = 0;
    let functions = 0;
    let classes = 0;
    let failures: DescribeProjectResult['failures'] = [];

    if (sample.length > 0) {
      const qsDeps: QueryStructureDeps = {
        fs,
        codeIntelligence,
        emitter,
        engineId,
        root,
        config,
      };
      const queries: TreeSitterQuery[] = [
        ...STD_QUERY_FUNCTION_SIGNATURES,
        ...CLASS_DECL_QUERIES,
        ...TYPE_QUERIES,
        ...STD_QUERY_EXPORTS,
        ...STD_QUERY_IMPORTS,
      ];
      const qs = await queryStructure(
        qsDeps,
        {
          projectId: validated.projectId,
          runId: validated.runId,
          correlationId: validated.correlationId,
          files: sample,
          queries,
        },
        signal,
      );
      failures = uniqueFailures(qs.failures);
      for (const m of qs.matches) {
        switch (m.queryId) {
          case 'extract-function-signatures':
            functions += 1;
            break;
          case 'project-class-decl':
            classes += 1;
            break;
          case 'project-type-decl':
            types += 1;
            break;
          case 'extract-exports':
            exports += 1;
            break;
          case 'extract-imports':
            imports += 1;
            break;
          default:
            break;
        }
      }
    }

    result = {
      files: { total, byLanguage },
      symbols: { exports, imports, types, functions, classes },
      filesScanned: sample.length,
      truncated,
      failures,
    };
  } catch (err) {
    emitter.emit({
      op: 'describeProject',
      phase: 'error',
      engineId,
      projectId: validated.projectId,
      runId: validated.runId,
      correlationId: validated.correlationId,
      durationMs: Date.now() - startMs,
    });
    throw err;
  }

  emitter.emit({
    op: 'describeProject',
    phase: 'end',
    engineId,
    projectId: validated.projectId,
    runId: validated.runId,
    correlationId: validated.correlationId,
    durationMs: Date.now() - startMs,
    classification: 'PASS',
  });

  return result;
}

function uniqueFailures(
  failures: DescribeProjectResult['failures'],
): DescribeProjectResult['failures'] {
  return [...new Map(failures.map((f) => [`${f.path}\u0000${f.reason}\u0000${f.message}`, f])).values()]
    .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.message.localeCompare(b.message)));
}
