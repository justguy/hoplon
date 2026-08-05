import { z } from 'zod';

export const RepairSuggestionSchema = z.object({
  advisoryOnly: z.literal(true),
  requiresConfirmation: z.literal(true),
  action: z.enum([
    'retry_with_correction',
    'inspect_target_identity',
    'revise_manifest_scope',
    'rerun_with_fresh_snapshot',
  ]),
  violationKind: z.string().min(1),
  path: z.string().min(1).nullable(),
  message: z.string().min(1),
  correctionAvailable: z.boolean(),
});
export type RepairSuggestion = z.infer<typeof RepairSuggestionSchema>;
