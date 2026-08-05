import { z } from 'zod';

export const TokenTelemetrySchema = z.object({
  estimator: z.literal('bytes_div_4_v1'),
  estimated: z.literal(true),
  rawBytesConsidered: z.number().int().nonnegative().nullable(),
  returnedBytes: z.number().int().nonnegative(),
  estimatedRawTokens: z.number().int().nonnegative().nullable(),
  estimatedReturnedTokens: z.number().int().nonnegative(),
  estimatedTokensSaved: z.number().int().nullable(),
  compressionRatio: z.number().nonnegative().nullable(),
  notes: z.array(z.string().min(1)).default([]),
});

export type TokenTelemetry = z.infer<typeof TokenTelemetrySchema>;

export function estimateTokensFromBytes(bytes: number): number {
  if (bytes <= 0) return 0;
  return Math.ceil(bytes / 4);
}

export function buildTokenTelemetry(input: {
  rawBytesConsidered: number | null;
  returnedBytes: number;
  notes?: readonly string[];
}): TokenTelemetry {
  const estimatedRawTokens =
    input.rawBytesConsidered === null
      ? null
      : estimateTokensFromBytes(input.rawBytesConsidered);
  const estimatedReturnedTokens = estimateTokensFromBytes(input.returnedBytes);
  return {
    estimator: 'bytes_div_4_v1',
    estimated: true,
    rawBytesConsidered: input.rawBytesConsidered,
    returnedBytes: input.returnedBytes,
    estimatedRawTokens,
    estimatedReturnedTokens,
    estimatedTokensSaved:
      estimatedRawTokens === null
        ? null
        : Math.max(0, estimatedRawTokens - estimatedReturnedTokens),
    compressionRatio:
      input.rawBytesConsidered === null || input.rawBytesConsidered === 0
        ? null
        : input.returnedBytes / input.rawBytesConsidered,
    notes: [...(input.notes ?? [])],
  };
}
