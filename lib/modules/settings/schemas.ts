import { z } from "zod";

// Same bound as the DB check constraints (20260823201517) — 0..10080
// (7 days in minutes). Validated here too so a bad value gets a normal
// form-validation error instead of a raw Postgres constraint failure.
const cutoffMinutes = z.number().int().min(0).max(10080);

/**
 * Faz 2I.4B — partial by design. Every policy field is optional so the
 * client can send only what actually changed since its last successful
 * save; the server builds its UPDATE from whichever of these keys are
 * actually present (see updateSelfServicePolicyAction), leaving every
 * omitted column completely untouched in Postgres. The refine below is
 * the one thing still required: at least one policy field, so a caller
 * can never trigger a genuinely empty write (the client-side "don't
 * send if nothing is dirty" guard is the first line of defense, but the
 * server validates its own precondition independently rather than
 * trusting the client). Unknown keys are stripped, not rejected — same
 * lenient behavior a plain z.object() already had before this change.
 */
export const selfServicePolicySchema = z
  .object({
    tenantId: z.string().uuid(),
    tenantSlug: z.string().trim().min(1),
    cancellationEnabled: z.boolean().optional(),
    cancellationCutoffMinutes: cutoffMinutes.optional(),
    rescheduleEnabled: z.boolean().optional(),
    rescheduleCutoffMinutes: cutoffMinutes.optional(),
  })
  .refine(
    (v) =>
      v.cancellationEnabled !== undefined ||
      v.cancellationCutoffMinutes !== undefined ||
      v.rescheduleEnabled !== undefined ||
      v.rescheduleCutoffMinutes !== undefined,
    { message: "En az bir ayar alanı gönderilmelidir" },
  );

export type SelfServicePolicyInput = z.infer<typeof selfServicePolicySchema>;
