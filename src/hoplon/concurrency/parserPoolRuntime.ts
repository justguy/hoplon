import { availableParallelism } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { AdapterError } from '../contracts/errors.js';
import type {
  ParseRequest,
  ParserPool,
  ParserPoolOptions,
  ParserPoolStats,
  PendingParse,
  SerializedSyntaxTree,
  WorkerMessage,
  WorkerSlot,
} from './parserPoolTypes.js';

const moduleDir = fileURLToPath(new URL('.', import.meta.url));
const WORKER_SCRIPT = resolve(moduleDir, 'parserWorker.js');

/** Create a lazy worker pool for deterministic, independent parser requests. */
export function createParserPool(opts: ParserPoolOptions): ParserPool {
  const size = Math.max(1, opts.size ?? Math.min(availableParallelism(), 8));
  const { grammarsDir } = opts;
  const idleTimeoutMs = opts.idleTimeoutMs ?? 30_000;
  const workerScript = opts.workerScript ?? WORKER_SCRIPT;
  const workerExecArgv = opts.workerExecArgv ?? [];
  const slots: WorkerSlot[] = [];
  const queue: PendingParse[] = [];
  const pending = new Map<number, PendingParse>();
  const parseToSlot = new Map<number, number>();
  let nextId = 1;
  let totalDispatched = 0;
  let isShuttingDown = false;

  function stats(): ParserPoolStats {
    const activeWorkers = slots.filter((slot) => slot.currentParseId !== null).length;
    return { size, activeWorkers, queueDepth: queue.length, totalDispatched };
  }

  function spawnWorker(): number {
    const slotIndex = slots.length;
    const worker = new Worker(workerScript, {
      workerData: { grammarsDir },
      execArgv: workerExecArgv,
    });
    slots.push({ worker, currentParseId: null, ready: false, idleTimer: null });
    worker.on('message', (msg: WorkerMessage) => onWorkerMessage(worker, msg));
    worker.on('error', (err) => onWorkerCrash(worker, err));
    worker.on('exit', (code) => {
      if (code !== 0 && !isShuttingDown) {
        onWorkerCrash(worker, new Error(`Worker exited with code ${code}`));
      }
    });
    return slotIndex;
  }

  function onWorkerMessage(worker: Worker, msg: WorkerMessage): void {
    const slotIndex = slots.findIndex((slot) => slot.worker === worker);
    if (slotIndex === -1) return;
    const slot = slots[slotIndex];
    if (!slot) return;
    if (msg.kind === 'ready') {
      slot.ready = true;
      if (!isShuttingDown && slot.currentParseId === null) armIdleTimer(slotIndex);
      drainQueue();
      return;
    }
    const parseId = msg.id;
    const parse = pending.get(parseId);
    pending.delete(parseId);
    parseToSlot.delete(parseId);
    freeSlot(slotIndex);
    if (parse && !parse.signal?.aborted) {
      if (msg.kind === 'parse_ok') parse.resolve(msg.tree);
      else {
        parse.reject(new AdapterError({
          kind: 'parser_init_failed',
          engineId: 'adapter',
          correlationId: 'pool',
          cause: msg.error,
        }, `Parser worker error: ${msg.error.message}`));
      }
    }
    drainQueue();
  }

  function onWorkerCrash(worker: Worker, cause: unknown): void {
    const slotIndex = slots.findIndex((slot) => slot.worker === worker);
    if (slotIndex === -1) return;
    const slot = slots[slotIndex];
    if (!slot) return;
    const parseId = slot.currentParseId;
    if (parseId !== null) {
      const parse = pending.get(parseId);
      pending.delete(parseId);
      parseToSlot.delete(parseId);
      if (parse && !parse.signal?.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause);
        parse.reject(new AdapterError({
          kind: 'parser_init_failed',
          engineId: 'adapter',
          correlationId: 'pool',
          cause,
        }, `Parser worker crashed: ${message}`));
      }
    } else {
      const queued = queue.shift();
      if (queued && !queued.signal?.aborted) {
        const message = cause instanceof Error ? cause.message : String(cause);
        queued.reject(new AdapterError({
          kind: 'parser_init_failed',
          engineId: 'adapter',
          correlationId: 'pool',
          cause,
        }, `Parser worker failed before ready: ${message}`));
      }
    }
    clearIdleTimer(slotIndex);
    slots.splice(slotIndex, 1);
    fixSlotIndexesAfterSplice(slotIndex);
    drainQueue();
  }

  function fixSlotIndexesAfterSplice(splicedIndex: number): void {
    for (const [parseId, slotIndex] of parseToSlot.entries()) {
      if (slotIndex > splicedIndex) parseToSlot.set(parseId, slotIndex - 1);
    }
  }

  function freeSlot(slotIndex: number): void {
    const slot = slots[slotIndex];
    if (!slot) return;
    slot.currentParseId = null;
    if (!isShuttingDown) armIdleTimer(slotIndex);
  }

  function armIdleTimer(slotIndex: number): void {
    const slot = slots[slotIndex];
    if (!slot) return;
    clearIdleTimer(slotIndex);
    slot.idleTimer = setTimeout(() => reapIdleWorker(slot.worker), idleTimeoutMs);
  }

  function clearIdleTimer(slotIndex: number): void {
    const slot = slots[slotIndex];
    if (slot?.idleTimer !== null && slot?.idleTimer !== undefined) {
      clearTimeout(slot.idleTimer);
      slot.idleTimer = null;
    }
  }

  function reapIdleWorker(worker: Worker): void {
    const slotIndex = slots.findIndex((slot) => slot.worker === worker);
    if (slotIndex === -1) return;
    const slot = slots[slotIndex];
    if (!slot || slot.currentParseId !== null) return;
    clearIdleTimer(slotIndex);
    try {
      slot.worker.postMessage({ kind: 'shutdown' });
    } catch {
      // A concurrently exiting worker needs no further action.
    }
    slots.splice(slotIndex, 1);
    fixSlotIndexesAfterSplice(slotIndex);
  }

  function findIdleReadySlot(): number | null {
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index]!;
      if (slot.ready && slot.currentParseId === null) return index;
    }
    return null;
  }

  function dispatchToSlot(slotIndex: number, parse: PendingParse): void {
    const slot = slots[slotIndex];
    if (!slot) return;
    clearIdleTimer(slotIndex);
    slot.currentParseId = parse.id;
    pending.set(parse.id, parse);
    parseToSlot.set(parse.id, slotIndex);
    totalDispatched++;
    slot.worker.postMessage({
      kind: 'parse',
      id: parse.id,
      req: {
        file: parse.req.file,
        content: Array.from(parse.req.content),
        language: parse.req.language,
      },
    });
  }

  function drainQueue(): void {
    while (queue.length > 0) {
      while (queue.length > 0 && queue[0]!.signal?.aborted) queue.shift();
      if (queue.length === 0) break;
      const idleSlot = findIdleReadySlot();
      if (idleSlot !== null) dispatchToSlot(idleSlot, queue.shift()!);
      else if (slots.length < size) {
        spawnWorker();
        break;
      } else break;
    }
  }

  function parse(req: ParseRequest, signal?: AbortSignal): Promise<SerializedSyntaxTree> {
    if (isShuttingDown) {
      return Promise.reject(new AdapterError({
        kind: 'parser_init_failed',
        engineId: 'adapter',
        correlationId: 'pool',
      }, 'ParserPool is shutting down — no new parses accepted'));
    }
    if (signal?.aborted) return Promise.reject(abortError(signal));
    const id = nextId++;
    return new Promise<SerializedSyntaxTree>((resolve, reject) => {
      const queued: PendingParse = signal
        ? { id, req, signal, resolve, reject }
        : { id, req, resolve, reject };
      if (signal) {
        signal.addEventListener('abort', () => {
          const queueIndex = queue.indexOf(queued);
          if (queueIndex !== -1) queue.splice(queueIndex, 1);
          pending.delete(id);
          parseToSlot.delete(id);
          reject(abortError(signal));
        }, { once: true });
      }
      const idleSlot = findIdleReadySlot();
      if (idleSlot !== null) dispatchToSlot(idleSlot, queued);
      else {
        queue.push(queued);
        if (slots.length < size) spawnWorker();
      }
    });
  }

  function trackSettlement(parse: PendingParse): Promise<void> {
    return new Promise<void>((settled) => {
      const originalResolve = parse.resolve;
      const originalReject = parse.reject;
      parse.resolve = (tree) => { originalResolve(tree); settled(); };
      parse.reject = (error) => { originalReject(error); settled(); };
    });
  }

  async function shutdown(): Promise<void> {
    if (isShuttingDown) return;
    isShuttingDown = true;
    const allSettled: Promise<unknown>[] = [];
    while (queue.length > 0) {
      const queued = queue.shift()!;
      if (queued.signal?.aborted) continue;
      allSettled.push(trackSettlement(queued));
      const idleSlot = findIdleReadySlot();
      if (idleSlot !== null) dispatchToSlot(idleSlot, queued);
      else if (slots.length < size) {
        queue.unshift(queued);
        spawnWorker();
        break;
      } else {
        queue.unshift(queued);
        break;
      }
    }
    for (const queued of queue) {
      if (!queued.signal?.aborted) allSettled.push(trackSettlement(queued));
    }
    for (const active of pending.values()) allSettled.push(trackSettlement(active));
    await Promise.allSettled(allSettled);
    while (pending.size > 0 || queue.length > 0) {
      await new Promise<void>((resolveDelay) => setTimeout(resolveDelay, 5));
    }
    const terminations = slots.map((slot) => {
      clearIdleTimer(slots.indexOf(slot));
      try {
        slot.worker.postMessage({ kind: 'shutdown' });
      } catch {
        // A concurrently exiting worker needs no further action.
      }
      return slot.worker.terminate();
    });
    await Promise.allSettled(terminations);
    slots.length = 0;
  }

  return { parse, stats, shutdown };
}

function abortError(signal: AbortSignal): Error {
  if (signal.reason instanceof Error) return signal.reason;
  const message = typeof signal.reason === 'string' ? signal.reason : 'Parse aborted';
  return new DOMException(message, 'AbortError');
}
