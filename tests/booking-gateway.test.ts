import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  createTestTenant,
  createTestUser,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  cleanupTenants,
  cleanupUsers,
  type TestUser,
} from "./helpers";
import { processGuestBooking } from "../lib/modules/public-booking/gateway";
import type { GuestBookingGatewayInput } from "../lib/modules/public-booking/schemas";
import type { GuestBookingDbResult } from "../lib/modules/public-booking/gateway-db";

/**
 * Phase 2F.2 — the gateway's own logic (schema validation -> Turnstile
 * verification -> DB call -> safe response mapping), tested via
 * processGuestBooking directly with an injected Turnstile verifier —
 * never a real call to Cloudflare (see gateway.ts's own comment on why
 * this seam exists and why it carries no production bypass). Tests that
 * exercise the real DB path use the real booking_gateway connection
 * (gateway-db.ts's module-scope client) with only Turnstile mocked —
 * genuine integration coverage of "does the gateway correctly translate
 * a real DB response" without any Cloudflare network dependency.
 */

let owner: TestUser;
let tenant: { id: string; slug: string };
let branchId: string;
let serviceId: string;
let staffId: string;

const OK_VERIFIER = async () => ({ success: true as const });

function futureIso(daysFromNow: number, hour: number): string {
  const d = new Date(Date.now() + daysFromNow * 86400000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

function validInput(overrides: Partial<GuestBookingGatewayInput> = {}): GuestBookingGatewayInput {
  return {
    tenantSlug: tenant.slug,
    branchId,
    serviceId,
    scheduledStartAtUtc: futureIso(10, 10),
    customerFullName: "Gateway Test Customer",
    customerPhone: "5551230000",
    staffMemberId: staffId,
    idempotencyKey: crypto.randomUUID(),
    turnstileToken: "test-token",
    wantAccountClaim: false,
    ...overrides,
  };
}

beforeAll(async () => {
  owner = await createTestUser("p2f2-gw");
  const tenantRow = await createTestTenant("test-p2f2-gw", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };
  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature!.id}, true)`;

  branchId = await createBranch(tenant.id, "Gateway Branch");
  const service = await createService(tenant.id, "Gateway Service", 30, 150);
  serviceId = service.id;
  const staff = await createStaffMember(tenant.id, "Gateway Staff");
  staffId = staff.id;
  await linkServiceBranch(serviceId, branchId);
  await linkStaffBranch(staffId, branchId);
  await linkStaffService(staffId, serviceId);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staffId, weekday, "00:00", "23:59");
  }
}, 60000);

afterAll(async () => {
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id]);
});

describe("gateway", () => {
  it("9. valid Turnstile + valid payload succeeds through the real DB", async () => {
    const result = await processGuestBooking(validInput(), null, { verifyTurnstile: OK_VERIFIER });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.appointmentReference).toBeTruthy();
    }
  });

  it("10. invalid Turnstile token means the database is never called", async () => {
    let dbCalled = false;
    const result = await processGuestBooking(validInput(), null, {
      verifyTurnstile: async () => ({ success: false, errorCodes: ["invalid-input-response"] }),
      callDb: async () => {
        dbCalled = true;
        throw new Error("callDb must never be invoked when Turnstile verification fails");
      },
    });
    expect(result.success).toBe(false);
    expect(dbCalled).toBe(false);
  });

  it("11. missing/empty Turnstile token is rejected before verification even runs", async () => {
    let verifyCalled = false;
    const result = await processGuestBooking(validInput({ turnstileToken: "" }), null, {
      verifyTurnstile: async () => {
        verifyCalled = true;
        return { success: true };
      },
    });
    expect(result.success).toBe(false);
    expect(verifyCalled).toBe(false); // zod schema validation catches it first
  });

  it("12. a failed verification (representing a provider failure) never leaks provider diagnostics in the customer-facing message", async () => {
    const result = await processGuestBooking(validInput(), null, {
      verifyTurnstile: async () => ({ success: false, errorCodes: ["provider-unreachable", "some-internal-detail"] }),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).not.toMatch(/provider-unreachable|some-internal-detail/);
      expect(result.message.length).toBeGreaterThan(0);
    }
  });

  it("13. DB BK005 (slot taken) maps to a customer-safe message, not a raw code", async () => {
    const result = await processGuestBooking(validInput(), null, {
      verifyTurnstile: OK_VERIFIER,
      callDb: async () => ({ success: false, code: "BK005", message: "raise exception internal text" } satisfies GuestBookingDbResult),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe("Bu saat artık müsait değil. Lütfen başka bir saat seçin.");
      expect(result.message).not.toMatch(/BK005|raise exception/);
    }
  });

  it("14. DB BK007 (idempotency mismatch) maps to a customer-safe message, not a raw code", async () => {
    const result = await processGuestBooking(validInput(), null, {
      verifyTurnstile: OK_VERIFIER,
      callDb: async () => ({ success: false, code: "BK007", message: "raise exception internal text" } satisfies GuestBookingDbResult),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe("Bu randevu zaten oluşturulmuş.");
      expect(result.message).not.toMatch(/BK007|raise exception/);
    }
  });

  it("15/18. a raw, non-BK0nn database exception is sanitized to the generic fallback — connection/credential details never reach the customer", async () => {
    // The injected callDb here mirrors exactly what the real
    // callCreateGuestBooking returns on failure (success:false with a
    // code/message pair — it never throws, see that function's own
    // try/catch), with a message deliberately shaped like a real
    // Postgres connection-failure error (hostname + a credential-looking
    // fragment) to prove gateway.ts's mapping never echoes dbResult.message
    // to the customer under any code path — only the static, BK0nn-keyed
    // safe strings in error-codes.ts, or the generic fallback.
    const result = await processGuestBooking(validInput(), null, {
      verifyTurnstile: OK_VERIFIER,
      callDb: async () => ({
        success: false,
        code: "53300",
        message: "connection to booking_gateway.mfkzdgfyshlvvtuqoals@aws-1-eu-west-1.pooler.supabase.com failed: password=hunter2",
      } satisfies GuestBookingDbResult),
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.message).toBe("İşlem gerçekleştirilemedi, lütfen tekrar deneyin.");
      expect(result.message).not.toMatch(/password|hunter2|pooler\.supabase\.com|booking_gateway|53300/);
    }
  });

  it("16. idempotent retry through the gateway returns the same booking, no duplicate", async () => {
    const input = validInput({ scheduledStartAtUtc: futureIso(11, 10) });
    const first = await processGuestBooking(input, null, { verifyTurnstile: OK_VERIFIER });
    const second = await processGuestBooking(input, null, { verifyTurnstile: OK_VERIFIER });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.data.appointmentReference).toBe(first.data.appointmentReference);
    }
    const rows = await testDb`select id from appointments where idempotency_key = ${input.idempotencyKey}`;
    expect(rows.length).toBe(1);
  });

  it("17. a different Turnstile token on retry (CAPTCHA refresh) does not change which booking the idempotency key resolves to", async () => {
    const key = crypto.randomUUID();
    const shared = { idempotencyKey: key, scheduledStartAtUtc: futureIso(12, 10) };
    const first = await processGuestBooking(validInput({ ...shared, turnstileToken: "token-one" }), null, {
      verifyTurnstile: OK_VERIFIER,
    });
    const second = await processGuestBooking(validInput({ ...shared, turnstileToken: "token-two-after-refresh" }), null, {
      verifyTurnstile: OK_VERIFIER,
    });
    expect(first.success).toBe(true);
    expect(second.success).toBe(true);
    if (first.success && second.success) {
      expect(second.data.appointmentReference).toBe(first.data.appointmentReference);
    }
    const rows = await testDb`select id from appointments where idempotency_key = ${key}`;
    expect(rows.length).toBe(1);
  });

  it("19. the trusted account identity is passed to callDb as a value SEPARATE from the browser payload, never merged into it", async () => {
    // Faz 2G.1 trust-boundary proof at the gateway layer: rawInput (the
    // Zod-validated browser payload) carries no account-identity field at
    // all — the type doesn't have one — so the only way callDb could ever
    // see one is the explicit trustedAccountUserId parameter this test
    // passes directly, exactly mirroring how actions.ts derives it from
    // getCurrentUser() server-side, never from `input`.
    const fakeAccountUserId = crypto.randomUUID();
    let receivedAccountUserId: string | null | undefined;
    const result = await processGuestBooking(validInput({ scheduledStartAtUtc: futureIso(13, 10) }), fakeAccountUserId, {
      verifyTurnstile: OK_VERIFIER,
      callDb: async (dbInput) => {
        receivedAccountUserId = dbInput.customerAccountUserId;
        return { success: true, data: { appointmentReference: "diag" } };
      },
    });
    expect(result.success).toBe(true);
    expect(receivedAccountUserId).toBe(fakeAccountUserId);
  });

  it("20. the trusted account identity never appears anywhere in the public confirmation response", async () => {
    const accountUserId = crypto.randomUUID();
    const result = await processGuestBooking(validInput({ scheduledStartAtUtc: futureIso(14, 10) }), accountUserId, {
      verifyTurnstile: OK_VERIFIER,
      callDb: async () => ({
        success: true,
        data: {
          appointmentReference: "diag-ref",
          branchName: "B",
          serviceName: "S",
          staffName: "St",
          scheduledStartAt: futureIso(14, 10),
          durationMinutes: 30,
          price: 100,
          tenantTimezone: "Europe/Istanbul",
        },
      }),
    });
    expect(result.success).toBe(true);
    expect(JSON.stringify(result)).not.toContain(accountUserId);
  });
});

/**
 * Faz 2G.3.1 — the claim-secret GENERATION side of the trust boundary
 * lives entirely in gateway.ts (node:crypto, never Postgres — see that
 * module's own header), so it's tested here at the gateway layer with an
 * injected callDb, exactly like every other gateway.ts behavior above.
 * The RPC/database side (hash-only storage, two-proof completion,
 * link/concurrency/enumeration/security) is covered separately in
 * tests/future-booking-claim.test.ts, driven directly via testDb.
 */
describe("gateway — claim secret generation (Faz 2G.3.1)", () => {
  it("no opt-in (wantAccountClaim: false) never generates a secret or sends a hash to the database", async () => {
    let receivedHash: string | undefined = "unset";
    const result = await processGuestBooking(
      validInput({ customerEmail: "claim-test@example.com", wantAccountClaim: false }),
      null,
      {
        verifyTurnstile: OK_VERIFIER,
        callDb: async (dbInput) => {
          receivedHash = dbInput.claimSecretHash;
          return { success: true, data: { appointmentReference: "diag", claimIssued: false } };
        },
      },
    );
    expect(result.success).toBe(true);
    expect(receivedHash).toBeUndefined();
    if (result.success) expect(result.claimSecret).toBeUndefined();
  });

  it("opt-in without an email never generates a secret — nothing to bind proof B to", async () => {
    let receivedHash: string | undefined = "unset";
    const result = await processGuestBooking(
      validInput({ customerEmail: undefined, wantAccountClaim: true }),
      null,
      {
        verifyTurnstile: OK_VERIFIER,
        callDb: async (dbInput) => {
          receivedHash = dbInput.claimSecretHash;
          return { success: true, data: { appointmentReference: "diag", claimIssued: false } };
        },
      },
    );
    expect(result.success).toBe(true);
    expect(receivedHash).toBeUndefined();
  });

  it("an authenticated booker (trustedAccountUserId set) never generates a secret, even with opt-in + email", async () => {
    let receivedHash: string | undefined = "unset";
    const result = await processGuestBooking(
      validInput({ customerEmail: "claim-test@example.com", wantAccountClaim: true }),
      crypto.randomUUID(),
      {
        verifyTurnstile: OK_VERIFIER,
        callDb: async (dbInput) => {
          receivedHash = dbInput.claimSecretHash;
          return { success: true, data: { appointmentReference: "diag", claimIssued: false } };
        },
      },
    );
    expect(result.success).toBe(true);
    expect(receivedHash).toBeUndefined();
  });

  it("opt-in + email + guest booker generates a 256-bit secret, sends only its SHA-256 hash to the database, and returns the raw secret + claimRef separately from `data` when the database confirms claimIssued", async () => {
    let receivedHash: string | undefined;
    const fakeClaimRef = crypto.randomUUID();
    const result = await processGuestBooking(
      validInput({ customerEmail: "claim-test@example.com", wantAccountClaim: true }),
      null,
      {
        verifyTurnstile: OK_VERIFIER,
        callDb: async (dbInput) => {
          receivedHash = dbInput.claimSecretHash;
          return { success: true, data: { appointmentReference: "diag", claimIssued: true, claimRef: fakeClaimRef } };
        },
      },
    );
    expect(result.success).toBe(true);
    expect(receivedHash).toBeTruthy();
    expect(receivedHash).toMatch(/^[0-9a-f]{64}$/); // sha256 hex digest
    if (result.success) {
      expect(result.claimSecret).toBeTruthy();
      expect(result.claimSecret).toMatch(/^[0-9a-f]{64}$/); // 32 bytes hex = 256 bits
      expect(result.claimSecret).not.toBe(receivedHash); // raw secret, not its hash
      expect(result.claimRef).toBe(fakeClaimRef);
      expect(JSON.stringify(result.data)).not.toContain(result.claimSecret!); // never nested inside `data`
      expect(JSON.stringify(result.data)).not.toContain(fakeClaimRef); // claimRef stripped from `data` too (Faz 2G.3.1A)
    }
  });

  it("if the database reports claimIssued: false (best-effort creation failed/no-opped), the gateway never hands back a claim secret or ref — even though one was generated locally", async () => {
    const result = await processGuestBooking(
      validInput({ customerEmail: "claim-test@example.com", wantAccountClaim: true }),
      null,
      {
        verifyTurnstile: OK_VERIFIER,
        callDb: async () => ({ success: true, data: { appointmentReference: "diag", claimIssued: false, claimRef: null } }),
      },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.claimSecret).toBeUndefined();
      expect(result.claimRef).toBeUndefined();
    }
  });

  it("claimIssued: true but a missing claimRef (shouldn't happen, but must fail closed) never hands back a claim secret either", async () => {
    const result = await processGuestBooking(
      validInput({ customerEmail: "claim-test@example.com", wantAccountClaim: true }),
      null,
      {
        verifyTurnstile: OK_VERIFIER,
        callDb: async () => ({ success: true, data: { appointmentReference: "diag", claimIssued: true, claimRef: null } }),
      },
    );
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.claimSecret).toBeUndefined();
      expect(result.claimRef).toBeUndefined();
    }
  });
});
