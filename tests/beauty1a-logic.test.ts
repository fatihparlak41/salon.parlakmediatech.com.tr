/**
 * Faz BEAUTY.1A - the pure rules (presentation, experience columns) and the service Server Actions with a recording fake client.
 * No database. All figures and wording are the business's supplied catalogue facts or clearly synthetic.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const calls: { table: string; op: string; payload?: Record<string, unknown>; eq?: [string, unknown] }[] = [];
let failWith: { code?: string; message: string } | null = null;
const client = {
  from: (table: string) => ({
    insert: (payload: Record<string, unknown>) => {
      calls.push({ table, op: "insert", payload });
      return { select: () => ({ single: async () => ({ data: failWith ? null : { id: "new-id" }, error: failWith }) }), error: failWith };
    },
    update: (payload: Record<string, unknown>) => ({
      eq: async (col: string, val: unknown) => {
        calls.push({ table, op: "update", payload, eq: [col, val] });
        return { error: failWith };
      },
    }),
  }),
};
vi.mock("@/lib/supabase/server", () => ({ createClient: vi.fn(async () => client) }));
vi.mock("@/lib/auth/session", () => ({ requireUser: vi.fn(async () => ({ id: "u" })) }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));

import { durationLine, formatPublicPrice, hasServiceInfo, isDirectlyBookable, priceLine, resolveStaffStep } from "@/lib/modules/public-booking/service-presentation";
import {
  emptyExperienceForm, experienceColumns, experienceFormFromRow, experienceFormToInput, validateExperience,
} from "@/lib/modules/services/experience";
import { createServiceAction, updateServiceProfileAction } from "@/lib/modules/services/actions";

describe("price wording", () => {
  it("whole liras without decimals, grouped the Turkish way; fractions keep two decimals; never rounded to another amount", () => {
    expect(formatPublicPrice(2000)).toBe("2.000 ₺");
    expect(formatPublicPrice(600)).toBe("600 ₺");
    expect(formatPublicPrice(2500)).toBe("2.500 ₺");
    expect(formatPublicPrice(10.05)).toBe("10,05 ₺");
    expect(formatPublicPrice(10.5)).toBe("10,50 ₺");
  });

  it("fixed + shown -> the amount; inquiry -> the inquiry wording even if a number sneaks in; fixed hidden -> nothing; 0 is never presented as a price for inquiry", () => {
    expect(priceLine({ pricingMode: "fixed", price: 2000 })).toEqual({ kind: "price", text: "2.000 ₺" });
    expect(priceLine({ pricingMode: "fixed", price: null })).toEqual({ kind: "none" });
    expect(priceLine({ pricingMode: "inquiry", price: null })).toEqual({ kind: "inquiry" });
    expect(priceLine({ pricingMode: "inquiry", price: 0 })).toEqual({ kind: "inquiry" });
    expect(priceLine({ pricingMode: "inquiry", price: 1234 })).toEqual({ kind: "inquiry" });
  });
});

describe("display duration", () => {
  it("range, single value, equal bounds, and nothing when unset - never derived from anything else", () => {
    expect(durationLine({ displayDurationMin: 30, displayDurationMax: 40 }, "dk")).toBe("30–40 dk");
    expect(durationLine({ displayDurationMin: 10, displayDurationMax: 15 }, "dk")).toBe("10–15 dk");
    expect(durationLine({ displayDurationMin: 40, displayDurationMax: null }, "dk")).toBe("40 dk");
    expect(durationLine({ displayDurationMin: 50, displayDurationMax: 50 }, "dk")).toBe("50 dk");
    expect(durationLine({ displayDurationMin: null, displayDurationMax: null }, "dk")).toBeNull();
    expect(durationLine({ displayDurationMin: null, displayDurationMax: 30 }, "dk")).toBeNull();
  });
});

describe("booking mode, information, staff step", () => {
  it("only 'direct' is bookable", () => {
    expect(isDirectlyBookable({ bookingMode: "direct" })).toBe(true);
    expect(isDirectlyBookable({ bookingMode: "inquiry" })).toBe(false);
  });

  it("the information step exists when ANY of details / preparation / aftercare / important is written, not for a bare card line", () => {
    const none = { details: null, preparationNote: null, aftercareNote: null, importantNote: null };
    expect(hasServiceInfo(none)).toBe(false);
    for (const k of ["details", "preparationNote", "aftercareNote", "importantNote"] as const) expect(hasServiceInfo({ ...none, [k]: "x" }), k).toBe(true);
  });

  it("exactly one eligible person -> auto with that id; several -> choose; none -> none", () => {
    expect(resolveStaffStep([{ id: "e", fullName: "Emel Kaynakkan" }])).toEqual({ kind: "auto", staffId: "e" });
    expect(resolveStaffStep([{ id: "a", fullName: "A" }, { id: "b", fullName: "B" }])).toEqual({ kind: "choose" });
    expect(resolveStaffStep([])).toEqual({ kind: "none" });
  });
});

describe("experience columns and validation", () => {
  it("inquiry pricing forces inquiry booking, price 0 and no public price - whatever else was sent", () => {
    expect(experienceColumns({ pricingMode: "inquiry", bookingMode: "direct", pricePublic: true })).toMatchObject({ pricing_mode: "inquiry", booking_mode: "inquiry", price_public: false, price: 0 });
  });

  it("fixed pricing writes only what was provided; an absent field is left alone", () => {
    expect(experienceColumns({})).toEqual({});
    expect(experienceColumns({ pricingMode: "fixed", bookingMode: "inquiry", pricePublic: true })).toEqual({ pricing_mode: "fixed", booking_mode: "inquiry", price_public: true });
    expect(experienceColumns({ pricePublic: false })).toEqual({ price_public: false });
  });

  it("display duration: min sets both bounds, clearing the min clears both, absent leaves both", () => {
    expect(experienceColumns({ displayDurationMin: 30, displayDurationMax: 40 })).toEqual({ display_duration_min: 30, display_duration_max: 40 });
    expect(experienceColumns({ displayDurationMin: 40 })).toEqual({ display_duration_min: 40, display_duration_max: null });
    expect(experienceColumns({ displayDurationMin: null, displayDurationMax: 40 })).toEqual({ display_duration_min: null, display_duration_max: null });
    expect(experienceColumns({ publicSummary: "x" })).not.toHaveProperty("display_duration_min");
  });

  it("copy is trimmed; blank becomes null; each field maps to its own column", () => {
    expect(experienceColumns({ publicSummary: "  kısa  ", publicDetails: "", preparationNote: "hazırlık", aftercareNote: "sonrası", importantNote: "önemli", badgeLabel: "etiket" })).toEqual({
      public_summary: "kısa", public_details: null, preparation_note: "hazırlık", aftercare_note: "sonrası", important_note: "önemli", badge_label: "etiket",
    });
  });

  it("validation: a maximum without a minimum, a backwards range, and over-long copy are refused; the rest passes", () => {
    expect(validateExperience({})).toBeNull();
    expect(validateExperience({ displayDurationMin: 30, displayDurationMax: 40 })).toBeNull();
    expect(validateExperience({ displayDurationMin: 40, displayDurationMax: 40 })).toBeNull();
    expect(validateExperience({ displayDurationMin: null, displayDurationMax: 40 })).not.toBeNull();
    expect(validateExperience({ displayDurationMax: 40 })).not.toBeNull();
    expect(validateExperience({ displayDurationMin: 40, displayDurationMax: 30 })).not.toBeNull();
    expect(validateExperience({ publicSummary: "x".repeat(160) })).toBeNull();
    expect(validateExperience({ publicSummary: "x".repeat(161) })).not.toBeNull();
    expect(validateExperience({ preparationNote: "x".repeat(301) })).not.toBeNull();
    expect(validateExperience({ importantNote: "x".repeat(201) })).not.toBeNull();
    expect(validateExperience({ badgeLabel: "x".repeat(41) })).not.toBeNull();
    expect(validateExperience({ publicDetails: "x".repeat(1001) })).not.toBeNull();
  });

  it("every form field lands in its own input field", () => {
    const f = { pricingMode: "fixed", bookingMode: "inquiry", pricePublic: true, displayMin: "5", displayMax: "6", summary: "s1", details: "d2", preparation: "p3", aftercare: "a4", important: "i5", badge: "b6", rebookMin: "28", rebookMax: "56" } as const;
    // RC.1A: the one service model also carries BEAUTY.1B's re-booking window
    expect(experienceFormToInput(f)).toEqual({ pricingMode: "fixed", bookingMode: "inquiry", pricePublic: true, displayDurationMin: 5, displayDurationMax: 6, publicSummary: "s1", publicDetails: "d2", preparationNote: "p3", aftercareNote: "a4", importantNote: "i5", badgeLabel: "b6", rebookMinDays: 28, rebookMaxDays: 56 });
  });

  it("the form maps to the action input and back without loss; inquiry in the form is inquiry everywhere", () => {
    const f = { ...emptyExperienceForm(), pricingMode: "inquiry" as const, bookingMode: "direct" as const, pricePublic: true, displayMin: "30", displayMax: "40", summary: "s", preparation: "p" };
    expect(experienceFormToInput(f)).toMatchObject({ pricingMode: "inquiry", bookingMode: "inquiry", pricePublic: false, displayDurationMin: 30, displayDurationMax: 40, publicSummary: "s", preparationNote: "p" });
    const row = { pricingMode: "fixed" as const, bookingMode: "direct" as const, pricePublic: true, displayDurationMin: 10, displayDurationMax: null, publicSummary: null, publicDetails: "d", preparationNote: null, aftercareNote: null, importantNote: "i", badgeLabel: "b", rebookMinDays: 28, rebookMaxDays: 56 };
    expect(experienceFormFromRow(row)).toEqual({ pricingMode: "fixed", bookingMode: "direct", pricePublic: true, displayMin: "10", displayMax: "", summary: "", details: "d", preparation: "", aftercare: "", important: "i", badge: "b", rebookMin: "28", rebookMax: "56" });
    expect(experienceFormToInput(emptyExperienceForm())).toMatchObject({ displayDurationMin: null, displayDurationMax: null, pricingMode: "fixed", bookingMode: "direct" });
  });
});

describe("service Server Actions", () => {
  const T = "11111111-1111-4111-8111-111111111111";
  const B = "22222222-2222-4222-8222-222222222222";
  const S = "33333333-3333-4333-8333-333333333333";
  beforeEach(() => {
    calls.length = 0;
    failWith = null;
  });

  it("create: a fixed service with copy writes price and the generic columns together", async () => {
    const r = await createServiceAction(null, { tenantId: T, tenantSlug: "x", name: "Kaş Laminasyonu", durationMinutes: 30, price: "2000", branchIds: [], pricingMode: "fixed", bookingMode: "direct", pricePublic: true, displayDurationMin: 30, displayDurationMax: 40, preparationNote: "  Lütfen kaşlarınızı almadan geliniz.  " });
    expect(r.success).toBe(true);
    expect(calls[0]!.payload).toMatchObject({ tenant_id: T, name: "Kaş Laminasyonu", price: 2000, pricing_mode: "fixed", booking_mode: "direct", price_public: true, display_duration_min: 30, display_duration_max: 40, preparation_note: "Lütfen kaşlarınızı almadan geliniz." });
  });

  it("create: an inquiry service is stored with price 0, inquiry booking and no public price even if the form said otherwise", async () => {
    await createServiceAction(null, { tenantId: T, tenantSlug: "x", name: "Gelin Makyajı", durationMinutes: 60, price: "5000", branchIds: [], pricingMode: "inquiry", bookingMode: "direct", pricePublic: true });
    expect(calls[0]!.payload).toMatchObject({ price: 0, pricing_mode: "inquiry", booking_mode: "inquiry", price_public: false });
  });

  it("create: a backwards display range is refused before the database", async () => {
    const r = await createServiceAction(null, { tenantId: T, tenantSlug: "x", name: "A", durationMinutes: 30, price: "1", branchIds: [], displayDurationMin: 40, displayDurationMax: 30 });
    expect(r.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("RC.1A one model: create and update write the re-booking window together with the experience columns", async () => {
    await createServiceAction(null, { tenantId: T, tenantSlug: "x", name: "Kaş Laminasyonu", durationMinutes: 30, price: "2000", branchIds: [], pricePublic: true, rebookMinDays: 28, rebookMaxDays: 56 });
    expect(calls[0]!.payload).toMatchObject({ price_public: true, rebook_min_days: 28, rebook_max_days: 56 });
    calls.length = 0;
    await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: S, name: "Kaş Laminasyonu", durationMinutes: 30, price: "2000", rebookMinDays: 21, rebookMaxDays: null });
    expect(calls[0]!.payload).toMatchObject({ rebook_min_days: 21, rebook_max_days: null });
    calls.length = 0;
    await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: S, name: "Kaş Laminasyonu", durationMinutes: 30, price: "2000" });
    expect(calls[0]!.payload).not.toHaveProperty("rebook_min_days");
  });

  it("create: no experience fields at all -> the insert carries none of them (existing callers are untouched)", async () => {
    await createServiceAction(null, { tenantId: T, tenantSlug: "x", name: "Saç Kesimi", durationMinutes: 45, price: "500", branchIds: [] });
    const keys = Object.keys(calls[0]!.payload!);
    expect(keys.sort()).toEqual(["category", "description", "duration_minutes", "name", "price", "tenant_id"]);
  });

  it("update: only the provided experience columns are sent; a backwards range is refused before the database", async () => {
    await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: S, name: "Kaş Alımı", durationMinutes: 30, price: "600", displayDurationMin: 10, displayDurationMax: 15 });
    expect(calls[0]!.payload).toMatchObject({ price: 600, display_duration_min: 10, display_duration_max: 15 });
    expect(calls[0]!.payload).not.toHaveProperty("pricing_mode");
    expect(calls[0]!.eq).toEqual(["id", S]);
    calls.length = 0;
    const bad = await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: S, name: "Kaş Alımı", durationMinutes: 30, price: "600", displayDurationMin: 15, displayDurationMax: 10 });
    expect(bad.success).toBe(false);
    expect(calls).toHaveLength(0);
  });

  it("a database refusal (RLS) is a plain permission message, never the database text", async () => {
    failWith = { code: "42501", message: 'new row violates row-level security policy for table "services"' };
    const r = await updateServiceProfileAction(null, { tenantSlug: "x", serviceId: S, name: "A", durationMinutes: 30, price: "1" });
    expect(r).toMatchObject({ success: false, error: { code: "UNAUTHORIZED" } });
    expect(JSON.stringify(r)).not.toContain("row-level");
    void B;
  });
});
