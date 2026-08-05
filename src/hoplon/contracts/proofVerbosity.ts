import { z } from 'zod';

export const ProofVerbositySchema = z.enum(['compact', 'normal', 'full-proof']);
export type ProofVerbosity = z.infer<typeof ProofVerbositySchema>;
