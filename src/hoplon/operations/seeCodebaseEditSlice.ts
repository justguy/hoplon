import { createHash } from 'node:crypto';

import type { HoplonFsAdapter } from '../adapters/fs.js';
import { canonicalizePath } from '../util/canonicalizePath.js';
import {
  assertStrictPathClass,
  assertStrictPathWithinFolder,
  assertStrictReadableBytes,
} from './seeCodebaseFilePolicy.js';

export interface ReadEditSliceOptions {
  engineId: string;
  correlationId: string;
  root: string;
  startLine: number;
  endLine: number;
  strictFilePolicy?: boolean;
  strictFolder?: string;
}

export interface EditSliceReadResult {
  path: string;
  startLine: number;
  endLine: number;
  byteRange: readonly [number, number];
  content: string;
  originalBytes: number;
  returnedBytes: number;
  newlineStyle: 'lf' | 'crlf' | 'mixed' | 'none';
  anchors: {
    beforeSha256: string;
    contentSha256: string;
    afterSha256: string;
    fullFileSha256: string;
  };
}

export class EditSliceUnavailableError extends Error {
  readonly kind = 'edit_slice_unavailable';

  constructor(message: string) {
    super(message);
    this.name = 'EditSliceUnavailableError';
  }
}

export async function readEditSlice(
  fs: HoplonFsAdapter,
  rawPath: string,
  opts: ReadEditSliceOptions,
): Promise<EditSliceReadResult> {
  canonicalizePath({
    path: rawPath,
    root: opts.root,
    engineId: opts.engineId,
    correlationId: opts.correlationId,
  });
  if (opts.strictFilePolicy) {
    assertStrictPathClass(rawPath);
    assertStrictPathWithinFolder(rawPath, opts.strictFolder ?? '');
  }
  const bytes = await fs.read(rawPath);
  if (opts.strictFilePolicy) assertStrictReadableBytes(rawPath, bytes);
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new EditSliceUnavailableError(
      `edit_slice requires valid UTF-8 text: ${rawPath}`,
    );
  }
  const lineStarts = computeLineStarts(text);
  const startIndex = opts.startLine - 1;
  if (startIndex >= lineStarts.length) {
    throw new EditSliceUnavailableError(
      `edit_slice startLine is outside file: ${rawPath}`,
    );
  }
  const endIndex = Math.min(opts.endLine, lineStarts.length);
  const charStart = lineStarts[startIndex] ?? 0;
  const charEnd =
    endIndex >= lineStarts.length
      ? text.length
      : (lineStarts[endIndex] ?? text.length);
  const encoder = new TextEncoder();
  const before = text.slice(0, charStart);
  const content = text.slice(charStart, charEnd);
  const after = text.slice(charEnd);
  const byteStart = encoder.encode(before).byteLength;
  const returnedBytes = encoder.encode(content).byteLength;
  return {
    path: rawPath,
    startLine: opts.startLine,
    endLine: Math.min(opts.endLine, lineStarts.length),
    byteRange: [byteStart, byteStart + returnedBytes],
    content,
    originalBytes: bytes.byteLength,
    returnedBytes,
    newlineStyle: detectNewlineStyle(text),
    anchors: {
      beforeSha256: sha256(before),
      contentSha256: sha256(content),
      afterSha256: sha256(after),
      fullFileSha256: sha256(text),
    },
  };
}

function computeLineStarts(text: string): number[] {
  const starts = [0];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] === '\n' && i + 1 < text.length) starts.push(i + 1);
  }
  return starts;
}

function detectNewlineStyle(text: string): 'lf' | 'crlf' | 'mixed' | 'none' {
  const crlf = (text.match(/\r\n/gu) ?? []).length;
  const lf = (text.match(/(?<!\r)\n/gu) ?? []).length;
  if (crlf === 0 && lf === 0) return 'none';
  if (crlf > 0 && lf > 0) return 'mixed';
  return crlf > 0 ? 'crlf' : 'lf';
}

function sha256(text: string): string {
  return `sha256:${createHash('sha256').update(text).digest('hex')}`;
}
