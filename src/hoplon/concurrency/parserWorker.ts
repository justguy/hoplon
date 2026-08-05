/**
 * concurrency/parserWorker.ts
 *
 * Node worker_threads script. Loaded by parserPool.ts for each worker.
 *
 * Lifecycle:
 *   1. On spawn: read workerData.grammarsDir, initialize web-tree-sitter + grammars once.
 *   2. On { kind: 'parse', id, req }: parse and respond with { kind: 'parse_ok', id, tree }
 *      or { kind: 'parse_err', id, error }.
 *   3. On { kind: 'shutdown' }: exit(0) cleanly.
 *
 * H20 compliance:
 *   charPosToBytePos mirrors treeSitter.ts charPosToBytePos — see SPIKE-UTF8 rationale.
 *   All byte ranges in SerializedNode use UTF-8 byte offsets, not UTF-16 code unit positions.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { Parser, Language } from 'web-tree-sitter';
import type { SerializedSyntaxTree } from './parserWorkerSerialization.js';

export type { SerializedNode } from './parserWorkerSerialization.js';

type SerializeTree = typeof import('./parserWorkerSerialization.js').serializeTree;
const serializationModuleUrl = new URL(
  import.meta.url.endsWith('.ts')
    ? './parserWorkerSerialization.ts'
    : './parserWorkerSerialization.js',
  import.meta.url,
);
const serializationModule = await import(serializationModuleUrl.href) as {
  serializeTree: SerializeTree;
};
export const serializeTree = serializationModule.serializeTree;

// ---------------------------------------------------------------------------
// Types — must match parserPool.ts (keep in sync; can't cross-import at runtime)
// ---------------------------------------------------------------------------

type SupportedLanguage = 'javascript' | 'typescript' | 'tsx';

interface ParseRequest {
  file: string;
  content: number[]; // Uint8Array serialized as number array for structured clone
  language: SupportedLanguage;
}

type IncomingMessage =
  | { kind: 'parse'; id: number; req: ParseRequest }
  | { kind: 'shutdown' };

type OutgoingMessage =
  | { kind: 'parse_ok'; id: number; tree: SerializedSyntaxTree }
  | { kind: 'parse_err'; id: number; error: { kind: string; message: string } }
  | { kind: 'ready' };

// ---------------------------------------------------------------------------
// Worker initialization
// ---------------------------------------------------------------------------

interface WorkerData {
  grammarsDir: string;
}

const grammarsDir = (workerData as WorkerData | null)?.grammarsDir ?? '';

type LanguageMap = Record<SupportedLanguage, Language>;
type ParserMap = Record<SupportedLanguage, Parser>;

let languages: LanguageMap | null = null;
let parsers: ParserMap | null = null;
let initError: { kind: string; message: string } | null = null;

async function initWorker(): Promise<void> {
  const runtimeWasmPath = resolve(grammarsDir, 'tree-sitter.wasm');

  try {
    await Parser.init({
      locateFile(scriptName: string): string {
        if (scriptName === 'tree-sitter.wasm') return runtimeWasmPath;
        return scriptName;
      },
    } as unknown as Parameters<typeof Parser.init>[0]);
  } catch (cause) {
    initError = {
      kind: 'parser_init_failed',
      message: `Worker: Failed to initialize web-tree-sitter from ${runtimeWasmPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
    return;
  }

  const grammarPaths: Record<SupportedLanguage, string> = {
    javascript: resolve(grammarsDir, 'tree-sitter-javascript.wasm'),
    typescript: resolve(grammarsDir, 'tree-sitter-typescript.wasm'),
    tsx: resolve(grammarsDir, 'tree-sitter-tsx.wasm'),
  };

  const loadedLanguages = {} as LanguageMap;

  for (const [lang, wasmPath] of Object.entries(grammarPaths) as [SupportedLanguage, string][]) {
    let wasmBytes: Buffer;
    try {
      wasmBytes = readFileSync(wasmPath);
    } catch (cause) {
      initError = {
        kind: 'parser_init_failed',
        message: `Worker: Grammar file for "${lang}" not found at ${wasmPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
      return;
    }
    try {
      loadedLanguages[lang] = await Language.load(wasmBytes);
    } catch (cause) {
      initError = {
        kind: 'parser_init_failed',
        message: `Worker: Failed to load "${lang}" grammar from ${wasmPath}: ${cause instanceof Error ? cause.message : String(cause)}`,
      };
      return;
    }
  }

  languages = loadedLanguages;

  parsers = {
    javascript: new Parser(),
    typescript: new Parser(),
    tsx: new Parser(),
  };
  parsers.javascript.setLanguage(languages.javascript);
  parsers.typescript.setLanguage(languages.typescript);
  parsers.tsx.setLanguage(languages.tsx);
}

// ---------------------------------------------------------------------------
// Message handler
// ---------------------------------------------------------------------------

function handleParse(id: number, req: ParseRequest): void {
  if (initError !== null) {
    const msg: OutgoingMessage = {
      kind: 'parse_err',
      id,
      error: initError,
    };
    parentPort!.postMessage(msg);
    return;
  }

  if (parsers === null || languages === null) {
    const msg: OutgoingMessage = {
      kind: 'parse_err',
      id,
      error: { kind: 'parser_init_failed', message: 'Worker: parsers not initialized' },
    };
    parentPort!.postMessage(msg);
    return;
  }

  const { language, content } = req;

  if (!(language in parsers)) {
    const msg: OutgoingMessage = {
      kind: 'parse_err',
      id,
      error: {
        kind: 'parser_init_failed',
        message: `Worker: unsupported language "${language}"`,
      },
    };
    parentPort!.postMessage(msg);
    return;
  }

  // Reconstruct Uint8Array from number[] (serialized via structured clone)
  const bytes = new Uint8Array(content);
  const sourceText = new TextDecoder('utf-8').decode(bytes);

  let tsTree;
  try {
    tsTree = parsers[language].parse(sourceText);
  } catch (cause) {
    const msg: OutgoingMessage = {
      kind: 'parse_err',
      id,
      error: {
        kind: 'parser_init_failed',
        message: `Worker: tree-sitter threw during parse: ${cause instanceof Error ? cause.message : String(cause)}`,
      },
    };
    parentPort!.postMessage(msg);
    return;
  }

  if (tsTree === null) {
    const msg: OutgoingMessage = {
      kind: 'parse_err',
      id,
      error: { kind: 'parser_init_failed', message: 'Worker: tree-sitter parse returned null' },
    };
    parentPort!.postMessage(msg);
    return;
  }

  const { nodes, rootIndex } = serializeTree(tsTree.rootNode, sourceText);
  const rootNode = nodes[rootIndex]!;

  const tree: SerializedSyntaxTree = {
    rootKind: rootNode.kind,
    rootByteRange: rootNode.byteRange,
    rootText: rootNode.text,
    nodes,
    language,
    grammarVersion: String(languages[language].abiVersion),
  };

  const msg: OutgoingMessage = { kind: 'parse_ok', id, tree };
  parentPort!.postMessage(msg);
}

// ---------------------------------------------------------------------------
// Boot sequence
// ---------------------------------------------------------------------------

// Only boot when actually running as a worker_threads worker. Importing this
// module on the main thread (e.g. to unit-test serializeTree) is side-effect
// free — parentPort is null there.
if (parentPort !== null) {
  const port = parentPort;

  initWorker().then(() => {
    // Signal ready — pool waits for this before dispatching parses
    const readyMsg: OutgoingMessage = { kind: 'ready' };
    port.postMessage(readyMsg);

    port.on('message', (msg: IncomingMessage) => {
      if (msg.kind === 'parse') {
        handleParse(msg.id, msg.req);
      } else if (msg.kind === 'shutdown') {
        process.exit(0);
      }
    });
  }).catch((cause) => {
    // Unhandled init failure — report and exit so pool sees the crash
    initError = {
      kind: 'parser_init_failed',
      message: `Worker: unhandled init error: ${cause instanceof Error ? cause.message : String(cause)}`,
    };
    const readyMsg: OutgoingMessage = { kind: 'ready' };
    port.postMessage(readyMsg);

    port.on('message', (msg: IncomingMessage) => {
      if (msg.kind === 'parse') {
        handleParse(msg.id, msg.req);
      } else if (msg.kind === 'shutdown') {
        process.exit(0);
      }
    });
  });
}
