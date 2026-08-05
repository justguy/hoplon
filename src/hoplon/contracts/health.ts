/**
 * health.ts — EngineHealth Zod schema and inferred type.
 *
 * adapters keys expanded to the 8 adapter names per ARCHITECTURE.md § 0.
 */

import { z } from 'zod';

import { SemanticHealthSchema } from './semanticHealth.js';

export const AdapterStatusSchema = z.enum(['ok', 'degraded', 'failed']);
export type AdapterStatus = z.infer<typeof AdapterStatusSchema>;

export const EngineHealthSchema = z.object({
  engineId: z.string().min(1),
  adapters: z.object({
    fs: AdapterStatusSchema,
    versioning: AdapterStatusSchema,
    snapshotStore: AdapterStatusSchema,
    lockProvider: AdapterStatusSchema,
    emitter: AdapterStatusSchema,
    codeIntelligence: AdapterStatusSchema,
    secretScanner: AdapterStatusSchema,
    staticAnalysis: AdapterStatusSchema,
  }),
  semantic: SemanticHealthSchema,
  uptimeMs: z.number().nonnegative(),
});

export type EngineHealth = z.infer<typeof EngineHealthSchema>;
