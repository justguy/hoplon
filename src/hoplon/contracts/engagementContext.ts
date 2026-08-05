/**
 * contracts/engagementContext.ts — strict agent engagement context.
 *
 * This additive DTO is echoed by strict agent read/search/edit requests so
 * transport wrappers can verify the presented engagement token through the
 * existing engagement lifecycle and policy-audit sink before dispatching.
 */

import { z } from 'zod';

export const StrictEngagementContextSchema = z.object({
  /** Opaque token returned by projects_handshake. Never logged. */
  token: z.string().min(1, 'engagement token must be non-empty'),
  /**
   * Canonical project-relative folder scope bound by the handshake. The
   * project root is represented as the empty string.
   */
  folder: z.string(),
  /**
   * Principal echoed from the engagement envelope. Null means the binding is
   * principal-agnostic; callers must not omit it in strict mode.
   */
  principalId: z.string().min(1).nullable(),
});

export type StrictEngagementContext = z.infer<
  typeof StrictEngagementContextSchema
>;
