import type { z } from 'zod';

import type { HoplonEngine } from '../../engine/types.js';

export type ProtoStreamingKind = 'none' | 'server';

export interface ProtoOperation {
  readonly method: keyof HoplonEngine;
  readonly rpcName: string;
  readonly hasRequestBody: boolean;
  readonly streaming: ProtoStreamingKind;
  readonly requestSchema: z.ZodTypeAny | null;
  readonly responseSchema: z.ZodTypeAny;
  readonly docLine: string;
}
