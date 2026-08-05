import type { Worker } from 'node:worker_threads';

export type SupportedLanguage = 'javascript' | 'typescript' | 'tsx';

export interface ParseRequest {
  /** File path, passed through to the parser worker. */
  file: string;
  /** File content as UTF-8 bytes. */
  content: Uint8Array;
  /** Explicit language determined by the caller before dispatch. */
  language: SupportedLanguage;
}

export interface SerializedNode {
  kind: string;
  byteRange: [number, number];
  text: string;
  childIndexes: number[];
  namedChildIndexes: number[];
}

export interface SerializedSyntaxTree {
  rootKind: string;
  rootByteRange: [number, number];
  rootText: string;
  nodes: SerializedNode[];
  language: SupportedLanguage;
  grammarVersion: string;
}

export interface ParserPoolStats {
  size: number;
  activeWorkers: number;
  queueDepth: number;
  totalDispatched: number;
}

export interface ParserPoolOptions {
  /** Max workers. Defaults to available parallelism capped at eight. */
  size?: number;
  grammarsDir: string;
  /** Workers idle longer than this are terminated. Default: 30 seconds. */
  idleTimeoutMs?: number;
  /** Override the sibling parserWorker.js path. */
  workerScript?: string;
  /** Additional arguments passed to Worker, primarily for test loaders. */
  workerExecArgv?: string[];
}

export interface ParserPool {
  parse(req: ParseRequest, signal?: AbortSignal): Promise<SerializedSyntaxTree>;
  stats(): ParserPoolStats;
  shutdown(): Promise<void>;
}

export type WorkerMessage =
  | { kind: 'ready' }
  | { kind: 'parse_ok'; id: number; tree: SerializedSyntaxTree }
  | { kind: 'parse_err'; id: number; error: { kind: string; message: string } };

export interface PendingParse {
  id: number;
  req: ParseRequest;
  signal?: AbortSignal;
  resolve: (tree: SerializedSyntaxTree) => void;
  reject: (err: unknown) => void;
}

export interface WorkerSlot {
  worker: Worker;
  currentParseId: number | null;
  ready: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
}
