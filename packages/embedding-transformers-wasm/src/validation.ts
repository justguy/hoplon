import {
  EMBEDDING_ADAPTER_CONTRACT_VERSION,
  type TransformersWasmEmbedRequest,
} from './types.js';

export function validateEmbedRequest(req: TransformersWasmEmbedRequest): void {
  if (req.contractVersion !== EMBEDDING_ADAPTER_CONTRACT_VERSION) {
    throw new TypeError('embed: contractVersion must be 2');
  }
  validateCorrelationId(req.correlationId, 'embed');
  const seen = new Set<string>();
  for (const input of req.inputs) {
    if (input.inputId.length === 0) {
      throw new TypeError('embed: inputId must be non-empty');
    }
    if (seen.has(input.inputId)) {
      throw new TypeError(`embed: duplicate inputId ${input.inputId}`);
    }
    seen.add(input.inputId);
  }
}

export function validateCorrelationId(correlationId: string, op: string): void {
  if (typeof correlationId !== 'string' || correlationId.length === 0) {
    throw new TypeError(`${op}: correlationId must be non-empty`);
  }
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted !== true) return;
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(
    typeof reason === 'string' ? reason : 'Operation aborted',
    'AbortError',
  );
}
