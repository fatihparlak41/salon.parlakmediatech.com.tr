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

/**
 * Faz 5A.3B — input shape for get_staff_utilization. Deliberately has NO
 * serviceIds field: there is no service-specific schedule/capacity
 * denominator anywhere in the schema, so a service-filtered numerator
 * divided by a staff-wide capacity would be structurally misleading. See
 * the migration's own header comment.
 */
export const staffUtilizationInputSchema = z
  .object({
    tenantId: z.string().uuid(),
    startAt: z.string().datetime({ offset: true }),
    endAt: z.string().datetime({ offset: true }),
    branchId: z.string().uuid().optional(),
    staffIds: z.array(z.string().uuid()).optional(),
  })
  .refine((v) => new Date(v.startAt).getTime() < new Date(v.endAt).getTime(), {
    message: "Başlangıç tarihi bitiş tarihinden önce olmalıdır.",
  });

export type StaffUtilizationInput = z.infer<typeof staffUtilizationInputSchema>;

/**
 * Faz 5A.3C — URL search-param filter contract for /reports/staff.
 * Deliberately lenient, not a hard-reject schema: a manipulated or
 * garbage query string must fall back to a safe default, never throw or
 * 500 the page (see parseReportsStaffFilters below). This is the ONLY
 * layer that touches raw, attacker-controlled search-param strings —
 * everything downstream (the RPC calls themselves) only ever sees
 * well-formed uuids/ISO timestamps, and is separately, independently
 * tenant-safe regardless (a foreign-tenant uuid slipping through here
 * would still just match zero rows — see personnel-performance-reports/
 * -utilization.test.ts's own tenant-isolation proofs — but this layer
 * doesn't rely on that; it filters non-uuid garbage out before it ever
 * reaches a query param).
 */
export const DATE_RANGE_PRESETS = ["today", "week", "month", "last30", "custom"] as const;
export type DateRangePreset = (typeof DATE_RANGE_PRESETS)[number];

export type ReportsStaffFilters = {
  range: DateRangePreset;
  /** "YYYY-MM-DD", tenant-local calendar dates. Only non-null when
   * range==="custom" AND both parsed validly AND start < end — otherwise
   * range itself is coerced back to the default preset. */
  customStart: string | null;
  customEnd: string | null;
  branchId: string | null;
  staffIds: string[];
  serviceIds: string[];
};

const DATE_STR_PATTERN = /^\d{4}-\d{2}-\d{2}$/;
const uuidSchema = z.string().uuid();

function firstParam(v: string | string[] | undefined): string | undefined {
  return Array.isArray(v) ? v[0] : v;
}

function parseUuidOrNull(v: string | undefined): string | null {
  if (!v) return null;
  return uuidSchema.safeParse(v).success ? v : null;
}

function parseUuidListFromCsv(v: string | undefined): string[] {
  if (!v) return [];
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => uuidSchema.safeParse(s).success);
}

/** DEFAULT_RANGE_PRESET: "Bu Ay" per the locked V1 default. */
export const DEFAULT_RANGE_PRESET: DateRangePreset = "month";

export function parseReportsStaffFilters(
  searchParams: Record<string, string | string[] | undefined>,
): ReportsStaffFilters {
  const rangeRaw = firstParam(searchParams.range);
  const requestedRange: DateRangePreset = (DATE_RANGE_PRESETS as readonly string[]).includes(rangeRaw ?? "")
    ? (rangeRaw as DateRangePreset)
    : DEFAULT_RANGE_PRESET;

  let range = requestedRange;
  let customStart: string | null = null;
  let customEnd: string | null = null;

  if (requestedRange === "custom") {
    const startRaw = firstParam(searchParams.start);
    const endRaw = firstParam(searchParams.end);
    const validStart = startRaw && DATE_STR_PATTERN.test(startRaw) ? startRaw : null;
    const validEnd = endRaw && DATE_STR_PATTERN.test(endRaw) ? endRaw : null;
    if (validStart && validEnd && validStart < validEnd) {
      customStart = validStart;
      customEnd = validEnd;
    } else {
      // Missing/invalid/inverted custom range -> fall back to the
      // default preset entirely rather than rendering a broken range.
      range = DEFAULT_RANGE_PRESET;
    }
  }

  return {
    range,
    customStart,
    customEnd,
    branchId: parseUuidOrNull(firstParam(searchParams.branch)),
    staffIds: parseUuidListFromCsv(firstParam(searchParams.staff)),
    serviceIds: parseUuidListFromCsv(firstParam(searchParams.service)),
  };
}
