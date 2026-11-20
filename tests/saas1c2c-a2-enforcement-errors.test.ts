import { describe, expect, it } from "vitest";
import { ENFORCEMENT_MESSAGES_TR, ENFORCEMENT_SQLSTATE_KINDS, enforcementMessage, mapEnforcementError } from "@/lib/modules/billing/enforcement-errors";
import { mapAppointmentErrorCode } from "@/lib/modules/appointments/error-codes";
import { mapFinanceErrorCode } from "@/lib/modules/finance/error-codes";
import { mapExpenseErrorCode } from "@/lib/modules/expenses/error-codes";
import { mapAccountErrorCode } from "@/lib/modules/customer-account/error-codes";
import { mapPublicBookingErrorCode } from "@/lib/modules/public-booking/error-codes";

/** Faz SAAS.1C.2c-A2 - the application side of the enforcement error contract (no database, no network). IDs: EE enforcement errors. */
describe("EE enforcement error contract", () => {
  it("EE1 the four SQLSTATEs map to the four stable kinds, and nothing else maps (never by message text)", () => {
    expect(mapEnforcementError("BL001")).toBe("subscription_read_only");
    expect(mapEnforcementError("BL002")).toBe("tenant_blocked");
    expect(mapEnforcementError("BL003")).toBe("public_booking_unavailable");
    expect(mapEnforcementError("BL004")).toBe("enforcement_guard_error");
    for (const other of ["BL005", "BK001", "AP001", "FN001", "23505", "42501", "", null, undefined, "constructor", "toString", "__proto__"]) expect(mapEnforcementError(other as string | null | undefined), String(other)).toBeNull();
    expect(Object.keys(ENFORCEMENT_SQLSTATE_KINDS)).toEqual(["BL001", "BL002", "BL003", "BL004"]);
  });

  it("EE2 the copy is customer-safe Turkish: no amounts, dates, database words or technical text", () => {
    for (const m of Object.values(ENFORCEMENT_MESSAGES_TR)) {
      expect(m).not.toMatch(/\d/);
      expect(m).not.toMatch(/postgres|sql|schema|relation|constraint|private\.|billing_|stage|aşama|trigger|exception|error/i);
      expect(m.length).toBeGreaterThan(10);
    }
    expect(enforcementMessage("BL003")).toBe("Online randevu şu anda kullanılamıyor.");
    expect(enforcementMessage("BL001")).toBe(enforcementMessage("BL002")); // roles other than Owner get one neutral line for any restricted state
    expect(enforcementMessage("XX000")).toBeNull();
  });

  it("EE3 every module mapper on a hooked path answers the enforcement codes first and keeps its own mapping for every other code", () => {
    const mappers: [string, (c: string | undefined | null) => string][] = [
      ["appointments", mapAppointmentErrorCode], ["finance", mapFinanceErrorCode], ["expenses", mapExpenseErrorCode], ["customer-account", mapAccountErrorCode], ["public-booking", mapPublicBookingErrorCode],
    ];
    for (const [name, map] of mappers) {
      for (const code of ["BL001", "BL002", "BL003", "BL004"]) expect(map(code), `${name} ${code}`).toBe(enforcementMessage(code));
      // unchanged behaviour: an unknown code still yields the module's own default message, and a null / undefined code too
      expect(map("ZZ999"), name).toBe(map(undefined));
      expect(map(null), name).toBe(map(undefined));
    }
    // a module's own stable code is untouched
    expect(mapPublicBookingErrorCode("BK001")).toBe("Online randevu şu anda kullanılamıyor.");
    expect(mapFinanceErrorCode("FN005")).toBe("Ödeme, kalan tutarı aşamaz.");
  });
});
