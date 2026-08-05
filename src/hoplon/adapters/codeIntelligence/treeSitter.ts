import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Language, Parser } from 'web-tree-sitter';
import type { Tree as TSTree } from 'web-tree-sitter';
import { AdapterError, EngineError } from '../../contracts/errors.js';
import type { CodeIntelligenceAdapter, SyntaxTree, Symbol } from '../codeIntelligence.js';
import {
  charPosToBytePos,
  detectLanguage,
  extractTopLevelSymbolsFromFacade,
  wrapNode,
} from './treeSitterFacade.js';
import type { RefinedSyntaxNode, RefinedSyntaxTree } from './treeSitterFacade.js';
import {
  TREE_SITTER_DEFAULT_PARSE_TIMEOUT_MS,
  TREE_SITTER_MAX_FILE_BYTES,
  type TreeSitterSupportedLanguage,
} from './treeSitterLimits.js';
import { createTreeSitterParseSession } from './treeSitterParseSession.js';

export { charPosToBytePos, detectLanguage } from './treeSitterFacade.js';
export type { RefinedSyntaxNode, RefinedSyntaxTree } from './treeSitterFacade.js';

const SENTINEL_ENGINE_ID = 'adapter';
const SENTINEL_CORR_ID = 'adapter-init';
type SupportedLanguage = TreeSitterSupportedLanguage;

export interface TreeSitterIntelligenceOptions {
  grammarsDir: string;
  /** Opt-in internal incremental parse cache; disabled by default. */
  enableIncrementalParse?: boolean;
}

/** Create the in-process web-tree-sitter adapter and load its three grammars. */
export async function createTreeSitterIntelligence(
  options: TreeSitterIntelligenceOptions,
): Promise<CodeIntelligenceAdapter> {
  const { grammarsDir } = options;
  const runtimeWasmPath = resolve(grammarsDir, 'tree-sitter.wasm');
  try {
    await Parser.init({
      locateFile(scriptName: string): string {
        return scriptName === 'tree-sitter.wasm' ? runtimeWasmPath : scriptName;
      },
    } as unknown as Parameters<typeof Parser.init>[0]);
  } catch (cause) {
    throw new EngineError({
      kind: 'wasm_load_failed',
      engineId: SENTINEL_ENGINE_ID,
      correlationId: SENTINEL_CORR_ID,
      cause,
    }, `Failed to initialize web-tree-sitter runtime from ${runtimeWasmPath}: ${errorMessage(cause)}`);
  }

  const grammarPaths: Record<SupportedLanguage, string> = {
    javascript: resolve(grammarsDir, 'tree-sitter-javascript.wasm'),
    typescript: resolve(grammarsDir, 'tree-sitter-typescript.wasm'),
    tsx: resolve(grammarsDir, 'tree-sitter-tsx.wasm'),
  };
  const languages = {} as Record<SupportedLanguage, Language>;
  for (const [language, wasmPath] of Object.entries(grammarPaths) as [SupportedLanguage, string][]) {
    let wasmBytes: Buffer;
    try {
      wasmBytes = readFileSync(wasmPath);
    } catch (cause) {
      throw new EngineError({
        kind: 'wasm_load_failed',
        engineId: SENTINEL_ENGINE_ID,
        correlationId: SENTINEL_CORR_ID,
        cause,
      }, `Grammar file for "${language}" not found at ${wasmPath}. Run: node scripts/fetch-grammars.js`);
    }
    try {
      languages[language] = await Language.load(wasmBytes);
    } catch (cause) {
      throw new EngineError({
        kind: 'grammar_not_registered',
        engineId: SENTINEL_ENGINE_ID,
        correlationId: SENTINEL_CORR_ID,
        cause,
      }, `Failed to load "${language}" grammar from ${wasmPath}: ${errorMessage(cause)}`);
    }
  }

  const parsers: Record<SupportedLanguage, Parser> = {
    javascript: new Parser(),
    typescript: new Parser(),
    tsx: new Parser(),
  };
  parsers.javascript.setLanguage(languages.javascript);
  parsers.typescript.setLanguage(languages.typescript);
  parsers.tsx.setLanguage(languages.tsx);
  const parseSession = options.enableIncrementalParse
    ? createTreeSitterParseSession<RefinedSyntaxTree>()
    : null;

  async function parse(
    file: string,
    content: Uint8Array,
    signal?: AbortSignal,
  ): Promise<RefinedSyntaxTree> {
    const language = detectLanguage(file);
    if (language === null) {
      const extension = file.includes('.') ? file.slice(file.lastIndexOf('.')) : '(none)';
      throw new AdapterError({
        kind: 'parser_init_failed',
        engineId: SENTINEL_ENGINE_ID,
        correlationId: SENTINEL_CORR_ID,
        cause: { reason: 'unsupported_extension', extension, file },
      }, `Unsupported extension "${extension}" (file: ${file}). Supported: .js .mjs .cjs .jsx .ts .tsx`);
    }
    if (content.byteLength > TREE_SITTER_MAX_FILE_BYTES) {
      throw new AdapterError({
        kind: 'parser_init_failed',
        engineId: SENTINEL_ENGINE_ID,
        correlationId: SENTINEL_CORR_ID,
        cause: {
          reason: 'file_too_large',
          sizeBytes: content.byteLength,
          limitBytes: TREE_SITTER_MAX_FILE_BYTES,
          file,
        },
      }, `File "${file}" exceeds hard ceiling of ${TREE_SITTER_MAX_FILE_BYTES} bytes (actual: ${content.byteLength})`);
    }
    const effectiveSignal = signal ?? AbortSignal.timeout(TREE_SITTER_DEFAULT_PARSE_TIMEOUT_MS);
    if (effectiveSignal.aborted) throw abortError(effectiveSignal);
    const sourceText = new TextDecoder('utf-8').decode(content);
    const parseFull = (): TSTree => {
      let tree: TSTree | null;
      try {
        tree = parsers[language].parse(sourceText);
      } catch (cause) {
        throw new AdapterError({
          kind: 'parser_init_failed',
          engineId: SENTINEL_ENGINE_ID,
          correlationId: SENTINEL_CORR_ID,
          cause,
        }, `tree-sitter threw during parse of "${file}": ${errorMessage(cause)}`);
      }
      if (tree === null) {
        throw new AdapterError({
          kind: 'parser_init_failed',
          engineId: SENTINEL_ENGINE_ID,
          correlationId: SENTINEL_CORR_ID,
          cause: { reason: 'parse_returned_null', file },
        }, `tree-sitter parse returned null for "${file}" (parser may have no language set)`);
      }
      return tree;
    };
    const buildResult = (tree: TSTree): RefinedSyntaxTree => ({
      rootNode: wrapNode(tree.rootNode, sourceText),
      language,
      grammarVersion: String(languages[language].abiVersion),
      _rawRootNode: tree.rootNode,
    });
    const result = parseSession === null
      ? buildResult(parseFull())
      : parseSession.parse({
          file,
          sourceText,
          parser: parsers[language],
          parseFull,
          buildResult,
        }).result;
    if (effectiveSignal.aborted) throw abortError(effectiveSignal);
    return result;
  }

  function getTopLevelSymbols(tree: SyntaxTree): Symbol[] {
    const root = (tree as RefinedSyntaxTree).rootNode;
    if (!Array.isArray(root.namedChildren) || root.namedChildren.length === 0) return [];
    return extractTopLevelSymbolsFromFacade(root.namedChildren as RefinedSyntaxNode[]);
  }

  return { parse, getTopLevelSymbols, _languages: languages } as unknown as CodeIntelligenceAdapter;
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === 'string' ? signal.reason : 'Parse aborted';
  return new DOMException(message, 'AbortError');
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

void charPosToBytePos;
