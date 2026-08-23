import { z } from "zod";

// Same bound as the DB check constraints (20260823201517) — 0..10080
// (7 days in minutes). Validated here too so a bad value gets a normal
// form-validation error instead of a raw Postgres constraint failure.
const cutoffMinutes = z.number().int().min(0).max(10080);

export const selfServicePolicySchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string().trim().min(1),
  cancellationEnabled: z.boolean(),
  cancellationCutoffMinutes: cutoffMinutes,
  rescheduleEnabled: z.boolean(),
  rescheduleCutoffMinutes: cutoffMinutes,
});

export type SelfServicePolicyInput = z.infer<typeof selfServicePolicySchema>;
