import { z } from 'zod';

export const REGRESSION_BISECT_OUTCOMES = [
  'REGRESSION_FOUND',
  'NO_REGRESSION',
  'INCONCLUSIVE',
] as const;
export const RegressionBisectOutcomeSchema = z.enum(
  REGRESSION_BISECT_OUTCOMES,
);
export type RegressionBisectOutcome = z.infer<
  typeof RegressionBisectOutcomeSchema
>;

export const REGRESSION_BISECT_VERDICTS = [
  'pass',
  'fail',
  'inconclusive',
] as const;
export const RegressionBisectVerifierVerdictSchema = z.enum(
  REGRESSION_BISECT_VERDICTS,
);
export type RegressionBisectVerifierVerdict = z.infer<
  typeof RegressionBisectVerifierVerdictSchema
>;

export const RegressionBisectRevisionSchema = z.object({
  revision: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
});
export type RegressionBisectRevision = z.infer<
  typeof RegressionBisectRevisionSchema
>;

export const RegressionBisectTranscriptEntrySchema = z.object({
  revision: z.string().min(1),
  ordinal: z.number().int().nonnegative(),
  verdict: RegressionBisectVerifierVerdictSchema,
  transcriptRef: z.string().min(1).nullable(),
});
export type RegressionBisectTranscriptEntry = z.infer<
  typeof RegressionBisectTranscriptEntrySchema
>;

export const RegressionBisectResultSchema = z.object({
  version: z.literal(1),
  outcome: RegressionBisectOutcomeSchema,
  firstFailingRevision: RegressionBisectRevisionSchema.nullable(),
  lastPassingRevision: RegressionBisectRevisionSchema.nullable(),
  transcript: z.array(RegressionBisectTranscriptEntrySchema),
  reason: z.string().min(1).nullable(),
});
export type RegressionBisectResult = z.infer<
  typeof RegressionBisectResultSchema
>;

export interface RegressionBisectVerifierResult {
  readonly verdict: RegressionBisectVerifierVerdict;
  readonly transcriptRef: string | null;
}

export interface RegressionBisectRunner {
  runAtRevision(
    revision: RegressionBisectRevision,
    signal?: AbortSignal,
  ): Promise<RegressionBisectVerifierResult>;
  cleanup?(): Promise<void>;
}
