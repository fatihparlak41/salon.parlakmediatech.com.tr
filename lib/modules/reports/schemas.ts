import { z } from "zod";

/**
 * Faz 5A.3A — input shape for get_staff_performance_summary. Mirrors the
 * RPC's own validation (RP003/RP004) at the TypeScript layer too, same
 * "narrow here, not just enforced server-side" convention as
 * lib/modules/appointments/schemas.ts's appointmentStatusSchema — the
 * RPC remains the actual authority regardless.
 *
 * NULL/undefined and an empty array both mean "no filter" for
 * staffIds/serviceIds — deliberately NOT normalized to one shape here;
 * the RPC itself treats both identically (coalesce(cardinality(...), 0) = 0),
 * so there is nothing this schema needs to collapse.
 */
export const staffPerformanceSummaryInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    branchId: z.string().uuid().optional(),
    staffIds: z.array(z.string().uuid()).optional(),
    serviceIds: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => new Date(v.startAt).getTime() < new Date(v.endAt).getTime(), {
    message: "Başlangıç tarihi bitiş tarihinden önce olmalıdır.",
  });

export type StaffPerformanceSummaryInput = z.infer<typeof staffPerformanceSummaryInputSchema>;
