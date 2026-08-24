import { randomBytes, createHash } from "node:crypto";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  testDb,
  createTestTenant,
  createTestUser,
  cleanupTenants,
  cleanupUsers,
  createBranch,
  createService,
  createStaffMember,
  createStaffSchedule,
  linkServiceBranch,
  linkStaffBranch,
  linkStaffService,
  signInAs,
  anonClient,
  type TestUser,
} from "./helpers";

/**
 * Faz 2G.3.1 / 2G.3.1A — Future Guest Booking Verified Claim
 * (20260824120000, 20260824140000).
 *
 * Security model under test: a future guest booking may be linked to a
 * customer account only after BOTH —
 *   PROOF A: possession of the booking-browser secret, bound to a
 *     specific claim_ref (booking_account_claims.id — a non-secret
 *     locator, never authority by itself; see the 2G.3.1A migration's
 *     own header). Here: knowledge of the raw secret, hashed with the
 *     exact same SHA-256 algorithm gateway.ts uses, since this file
 *     drives create_guest_booking/claim_my_recent_booking directly via
 *     testDb rather than through the Next.js layer.
 *   PROOF B: authenticating as the EXACT booking-time email snapshot
 *     (via a real signed-in session, signInAs) — never a live re-read
 *     of customers.email.
 * — both succeed, AND for the exact SAME claim_ref. Neither proof
 * alone, and no ref/secret mismatch, is ever sufficient.
 *
 * 2G.3.1A also closed two real bugs found by direct reproduction before
 * any fix (see the 2G.3.1A report): (1) a single global cookie/Magic
 * Link destination meant a second opted-in booking silently overwrote a
 * first, unclaimed one — fixed by the claim_ref correlation this file
 * now exercises throughout; (2) claim-opt-in guest bookings could
 * silently reuse an existing, already-historied or already-linked CRM
 * row via ordinary phone+name matching, indirectly exposing unrelated
 * legacy history through a fully verified claim — fixed by the
 * "legacy — new-row isolation" suite below, scoped strictly to
 * claim-opt-in bookings (see "non-claim guest regression" for proof the
 * ordinary matching path is untouched).
 *
 * This file does NOT cover the Next.js-layer cookie/Magic-Link wiring
 * (gateway.ts/actions.ts) directly — those are Server-Action-scoped side
 * effects with no test seam by design. Routing/redirect safety for the
 * claim_ref-carrying `next` path is covered separately in
 * tests/auth-hardening.test.ts (resolveSafeNext is a plain, directly
 * importable function; this file's own concern is the database trust
 * boundary).
 */

let owner: TestUser;
let claimUserA: TestUser; // will authenticate as the booking's own email
let claimUserB: TestUser; // a different account entirely
let existingLinkUser: TestUser; // pre-existing owner of a different customer row
// Signed in ONCE in beforeAll and reused across every test that needs
// that identity (rather than a fresh signInAs per assertion) — Supabase
// Auth's own sign-in rate limit is shared across the WHOLE test suite
// run, and this file's assertion count made a fresh sign-in per call a
// real, observed contributor to hitting it when run alongside every
// other suite. A real browser session behaves this way too: it stays
// authenticated across many actions, it doesn't re-authenticate before
// every click — auth.uid() inside claim_my_recent_booking is derived
// from the session's JWT either way, so reusing one session across
// several of this identity's assertions changes nothing about what's
// being proven.
let clientA: Awaited<ReturnType<typeof signInAs>>;
let clientB: Awaited<ReturnType<typeof signInAs>>;
let tenant: { id: string; slug: string };
let branchId: string;
let serviceId: string;
let staffId: string;

let dayCounter = 60;
/** Every call lands on its own distinct calendar day — with one shared
 * staff member across this whole file, this makes an
 * appointment_items_no_staff_overlap collision structurally impossible
 * regardless of service duration, matching the established
 * dedicated-fixture-separation convention used throughout this project's
 * other Phase 2G suites. */
function nextFutureIso(hour = 9): string {
  dayCounter += 1;
  const d = new Date(Date.now() + dayCounter * 86400000);
  return `${d.toISOString().slice(0, 10)}T${String(hour).padStart(2, "0")}:00:00.000Z`;
}

let phoneCounter = 0;
function uniquePhone(): string {
  phoneCounter += 1;
  return `555${String(1000000 + phoneCounter).padStart(7, "0")}`;
}

function newSecret(): { raw: string; hash: string } {
  const raw = randomBytes(32).toString("hex");
  const hash = createHash("sha256").update(raw).digest("hex");
  return { raw, hash };
}

async function bookDirect(params: {
  email?: string | null;
  claimSecretHash?: string | null;
  idempotencyKey?: string;
  customerAccountUserId?: string | null;
  scheduledStartAtUtc?: string;
  fullName?: string;
  phone?: string;
}) {
  const [row] = await testDb<{ create_guest_booking: Record<string, unknown> }[]>`
    select public.create_guest_booking(
      ${tenant.slug},
      ${branchId}::uuid,
      ${serviceId}::uuid,
      ${params.scheduledStartAtUtc ?? nextFutureIso()}::timestamptz,
      ${params.fullName ?? "Claim Test Customer"},
      ${params.phone ?? uniquePhone()},
      ${staffId}::uuid,
      ${params.email ?? null},
      ${params.idempotencyKey ?? crypto.randomUUID()}::uuid,
      ${params.customerAccountUserId ?? null}::uuid,
      ${params.claimSecretHash ?? null}
    )
  `;
  return row!.create_guest_booking as {
    appointmentReference: string;
    claimIssued: boolean;
    claimRef: string | null;
  };
}

async function getClaimRow(appointmentId: string) {
  const [row] = await testDb<
    {
      id: string;
      tenant_id: string;
      customer_id: string;
      appointment_id: string;
      email_snapshot: string;
      email_normalized_snapshot: string;
      secret_hash: string;
      expires_at: string;
      consumed_at: string | null;
      consumed_by_user_id: string | null;
    }[]
  >`select * from booking_account_claims where appointment_id = ${appointmentId}`;
  return row ?? null;
}

async function claimAs(client: Awaited<ReturnType<typeof signInAs>>, claimRef: string | null, secretHash: string) {
  // p_claim_ref has no SQL default (always required), so the generated
  // RPC type is strictly `string` — cast deliberately here so a couple
  // of tests below can still probe the real runtime behavior of a
  // missing/null ref, which a well-behaved caller would never construct
  // but a tampered request could.
  return client.rpc("claim_my_recent_booking", { p_claim_ref: claimRef as unknown as string, p_claim_secret_hash: secretHash });
}

beforeAll(async () => {
  owner = await createTestUser("p2g31-owner");
  claimUserA = await createTestUser("p2g31-claim-a");
  claimUserB = await createTestUser("p2g31-claim-b");
  existingLinkUser = await createTestUser("p2g31-existing-link");
  clientA = await signInAs(claimUserA);
  clientB = await signInAs(claimUserB);
  const tenantRow = await createTestTenant("test-p2g31-claim", owner.id);
  tenant = { id: tenantRow.id, slug: tenantRow.slug };

  const [feature] = await testDb<{ id: string }[]>`select id from features where key = 'online_booking'`;
  await testDb`insert into tenant_features (tenant_id, feature_id, enabled) values (${tenant.id}, ${feature!.id}, true)`;

  branchId = await createBranch(tenant.id, "Claim Branch");
  const service = await createService(tenant.id, "Claim Service", 30, 250);
  serviceId = service.id;
  const staff = await createStaffMember(tenant.id, "Claim Staff");
  staffId = staff.id;
  await linkServiceBranch(serviceId, branchId);
  await linkStaffBranch(staffId, branchId);
  await linkStaffService(staffId, serviceId);
  for (let weekday = 0; weekday <= 6; weekday++) {
    await createStaffSchedule(tenant.id, staffId, weekday, "00:00", "23:59");
  }
}, 60000);

afterAll(async () => {
  await clientA.auth.signOut();
  await clientB.auth.signOut();
  await testDb`delete from customer_account_links where tenant_id = ${tenant.id}`;
  await cleanupTenants([tenant.id]);
  await cleanupUsers([owner.id, claimUserA.id, claimUserB.id, existingLinkUser.id]);
});

describe("claim creation", () => {
  it("guest booking without opt-in (no secret hash) creates no claim row", async () => {
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: null });
    expect(result.claimIssued).toBe(false);
    expect(result.claimRef).toBeNull();
    expect(await getClaimRow(result.appointmentReference)).toBeNull();
  });

  it("guest booking without an email creates no claim row, even with a secret hash", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: null, claimSecretHash: hash });
    expect(result.claimIssued).toBe(false);
    expect(result.claimRef).toBeNull();
    expect(await getClaimRow(result.appointmentReference)).toBeNull();
  });

  it("guest booking with email + secret hash creates exactly one claim row, and claimRef matches its id", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    expect(result.claimIssued).toBe(true);
    expect(result.claimRef).toBeTruthy();
    const claim = await getClaimRow(result.appointmentReference);
    expect(claim).not.toBeNull();
    expect(claim!.id).toBe(result.claimRef);
    expect(claim!.secret_hash).toBe(hash);
  });

  it("stores an immutable email snapshot (raw + normalized) at booking time", async () => {
    const { hash } = newSecret();
    const rawEmail = `  ${claimUserA.email.toUpperCase()}  `;
    const result = await bookDirect({ email: rawEmail, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);
    expect(claim!.email_snapshot).toBe(rawEmail);
    expect(claim!.email_normalized_snapshot).toBe(claimUserA.email.toLowerCase());
  });

  it("a later CRM email edit does not alter the stored snapshot", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);

    await testDb`update customers set email = 'someone-else@example.com' where id = ${claim!.customer_id}`;

    const claimAfterEdit = await getClaimRow(result.appointmentReference);
    expect(claimAfterEdit!.email_normalized_snapshot).toBe(claimUserA.email.toLowerCase());
  });

  it("an authenticated booker (customerAccountUserId set) never gets a claim row, even with email + secret hash", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({
      email: claimUserA.email,
      claimSecretHash: hash,
      customerAccountUserId: existingLinkUser.id,
    });
    expect(result.claimIssued).toBe(false);
    expect(result.claimRef).toBeNull();
    expect(await getClaimRow(result.appointmentReference)).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${existingLinkUser.id}`;
  });

  it("an idempotent retry (same key, same fingerprint) does not create a duplicate appointment or a second claim row, and claimRef stays stable", async () => {
    const key = crypto.randomUUID();
    const { hash } = newSecret();
    const email = claimUserA.email;
    const phone = uniquePhone();
    const startAt = nextFutureIso();

    const first = await bookDirect({ email, claimSecretHash: hash, idempotencyKey: key, phone, scheduledStartAtUtc: startAt });
    const second = await bookDirect({ email, claimSecretHash: hash, idempotencyKey: key, phone, scheduledStartAtUtc: startAt });

    expect(second.appointmentReference).toBe(first.appointmentReference);
    expect(second.claimRef).toBe(first.claimRef);
    const appts = await testDb<{ count: string }[]>`select count(*)::text as count from appointments where idempotency_key = ${key}`;
    expect(appts[0]!.count).toBe("1");
    const claims = await testDb<{ count: string }[]>`select count(*)::text as count from booking_account_claims where appointment_id = ${first.appointmentReference}`;
    expect(claims[0]!.count).toBe("1");
  });
});

describe("browser capability", () => {
  it("the raw secret is never what's stored — secret_hash is the SHA-256 hash, not the plaintext", async () => {
    const { raw, hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);
    expect(claim!.secret_hash).not.toBe(raw);
    expect(claim!.secret_hash).toBe(hash);
  });

  it("a wrong (never-issued) secret hash, with the correct ref, fails claim completion", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const wrong = newSecret().hash;
    const { error } = await claimAs(clientA, result.claimRef, wrong);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("a missing/empty secret hash fails claim completion", async () => {
    const { error } = await claimAs(clientA, crypto.randomUUID(), "");
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("a missing/null claim ref fails claim completion", async () => {
    const { error } = await claimAs(clientA, null, newSecret().hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("an expired claim fails, even with the correct ref, secret, and matching email", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    await testDb`update booking_account_claims set expires_at = now() - interval '1 hour' where appointment_id = ${result.appointmentReference}`;

    const { error } = await claimAs(clientA, result.claimRef, hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("rotating the secret (retry with a new hash) keeps claim_ref stable but invalidates the old secret atomically", async () => {
    const key = crypto.randomUUID();
    const email = claimUserA.email;
    const phone = uniquePhone();
    const startAt = nextFutureIso();
    const a = newSecret();
    const b = newSecret();

    const first = await bookDirect({ email, claimSecretHash: a.hash, idempotencyKey: key, phone, scheduledStartAtUtc: startAt });
    const second = await bookDirect({ email, claimSecretHash: b.hash, idempotencyKey: key, phone, scheduledStartAtUtc: startAt });
    expect(second.claimRef).toBe(first.claimRef);

    const oldAttempt = await claimAs(clientA, first.claimRef, a.hash);
    expect(oldAttempt.error).not.toBeNull();
    expect(oldAttempt.error!.code).toBe("AC010");

    const newAttempt = await claimAs(clientA, first.claimRef, b.hash);
    expect(newAttempt.error).toBeNull();

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });
});

describe("email proof", () => {
  it("authenticating as the exact snapshot email, with the matching ref+secret, succeeds", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const { error } = await claimAs(clientA, result.claimRef, hash);
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("authenticating as a different Auth email fails", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const { error } = await claimAs(clientB, result.claimRef, hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("a CRM email later changed to a different value does not matter — the snapshot still governs", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);
    await testDb`update customers set email = ${claimUserB.email} where id = ${claim!.customer_id}`;

    // Bob (claimUserB) now "owns" the CRM row's live email field, but
    // must NOT be able to claim Alice's (claimUserA's) booking with it —
    // the worked threat example from 2G.3.0, now mechanically closed.
    const bobAttempt = await claimAs(clientB, result.claimRef, hash);
    expect(bobAttempt.error).not.toBeNull();
    expect(bobAttempt.error!.code).toBe("AC010");

    const aliceAttempt = await claimAs(clientA, result.claimRef, hash);
    expect(aliceAttempt.error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("correct email control WITHOUT the correct browser secret fails (proof A alone is not enough)", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const forged = newSecret().hash;
    const { error } = await claimAs(clientA, result.claimRef, forged);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("the correct browser secret WITHOUT the matching authenticated email fails (proof B alone is not enough)", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const { error } = await claimAs(clientB, result.claimRef, hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });
});

describe("claim_ref correlation", () => {
  it("REPRODUCTION-FIXED: two independently-pending claims in one 'browser' — clicking A's email now only ever attempts claim A", async () => {
    const secretA = newSecret();
    const secretB = newSecret();
    const bookingA = await bookDirect({ email: claimUserA.email, claimSecretHash: secretA.hash });
    const bookingB = await bookDirect({ email: claimUserA.email, claimSecretHash: secretB.hash });
    expect(bookingA.claimRef).not.toBe(bookingB.claimRef);

    // Both remain independently pending until acted on.
    const claimARow = await getClaimRow(bookingA.appointmentReference);
    const claimBRow = await getClaimRow(bookingB.appointmentReference);
    expect(claimARow!.consumed_at).toBeNull();
    expect(claimBRow!.consumed_at).toBeNull();

    // The guest followed booking A's email specifically — completion now
    // requires A's own ref, so it can only ever complete A.
    const { error } = await claimAs(clientA, bookingA.claimRef, secretA.hash);
    expect(error).toBeNull();

    const claimAAfter = await getClaimRow(bookingA.appointmentReference);
    const claimBAfter = await getClaimRow(bookingB.appointmentReference);
    expect(claimAAfter!.consumed_at).not.toBeNull(); // A claimed
    expect(claimBAfter!.consumed_at).toBeNull(); // B untouched — claiming A never clears/invalidates B

    // B remains independently claimable afterward.
    const bResult = await claimAs(clientA, bookingB.claimRef, secretB.hash);
    expect(bResult.error).toBeNull();

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("wrong ref + right secret fails generically (AC010)", async () => {
    const { hash } = newSecret();
    const bookingA = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const bookingB = await bookDirect({ email: claimUserA.email, claimSecretHash: newSecret().hash });

    // bookingA's secret hash, but presented under bookingB's ref.
    const { error } = await claimAs(clientA, bookingB.claimRef, hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");

    // Neither claim was consumed by the mismatched attempt.
    const claimA = await getClaimRow(bookingA.appointmentReference);
    const claimB = await getClaimRow(bookingB.appointmentReference);
    expect(claimA!.consumed_at).toBeNull();
    expect(claimB!.consumed_at).toBeNull();
  });

  it("right ref + wrong secret fails generically (AC010)", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const { error } = await claimAs(clientA, result.claimRef, newSecret().hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");
  });

  it("a random, never-issued ref fails identically to a wrong ref+secret combination", async () => {
    const forgedRef = await claimAs(clientA, crypto.randomUUID(), newSecret().hash);
    expect(forgedRef.error).not.toBeNull();
    expect(forgedRef.error!.code).toBe("AC010");
  });

  it("rotating claim A's secret leaves an unrelated pending claim B completely unchanged", async () => {
    const key = crypto.randomUUID();
    const phone = uniquePhone();
    const startAt = nextFutureIso();
    const a1 = newSecret();
    const a2 = newSecret();
    const bookingA1 = await bookDirect({ email: claimUserA.email, claimSecretHash: a1.hash, idempotencyKey: key, phone, scheduledStartAtUtc: startAt });

    const bSecret = newSecret();
    const bookingB = await bookDirect({ email: claimUserA.email, claimSecretHash: bSecret.hash });
    const claimBBefore = await getClaimRow(bookingB.appointmentReference);

    // Retry booking A with a rotated secret.
    const bookingA2 = await bookDirect({ email: claimUserA.email, claimSecretHash: a2.hash, idempotencyKey: key, phone, scheduledStartAtUtc: startAt });
    expect(bookingA2.claimRef).toBe(bookingA1.claimRef);

    const claimBAfter = await getClaimRow(bookingB.appointmentReference);
    expect(claimBAfter!.secret_hash).toBe(claimBBefore!.secret_hash);
    expect(claimBAfter!.id).toBe(claimBBefore!.id);
    expect(claimBAfter!.consumed_at).toBeNull();

    // B is still independently claimable with its own untouched secret.
    const { error } = await claimAs(clientA, bookingB.claimRef, bSecret.hash);
    expect(error).toBeNull();
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });
});

describe("link", () => {
  it("links exactly the one target customer row, no matching-email bulk linking", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);

    // A second, unrelated customer row in the SAME tenant that happens
    // to share the same email — must remain untouched by this claim.
    const [otherCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, email, status)
      values (${tenant.id}, 'Unrelated Same Email', ${uniquePhone()}, ${claimUserA.email}, 'active')
      returning id
    `;

    const { error } = await claimAs(clientA, result.claimRef, hash);
    expect(error).toBeNull();

    const links = await testDb<{ customer_id: string }[]>`
      select customer_id from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id} and deleted_at is null
    `;
    expect(links.map((l) => l.customer_id)).toEqual([claim!.customer_id]);
    expect(links.map((l) => l.customer_id)).not.toContain(otherCustomer!.id);

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
    await testDb`delete from customers where id = ${otherCustomer!.id}`;
  });

  it("becomes the primary link when the account has no primary yet in this tenant", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);

    await claimAs(clientA, result.claimRef, hash);

    const [link] = await testDb<{ is_primary: boolean }[]>`
      select is_primary from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id} and customer_id = ${claim!.customer_id}
    `;
    expect(link!.is_primary).toBe(true);
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("becomes a non-primary link when the account already has a primary in this tenant", async () => {
    const [existingCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, status) values (${tenant.id}, 'Pre-existing Primary', ${uniquePhone()}, 'active') returning id
    `;
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${claimUserA.id}, ${tenant.id}, ${existingCustomer!.id}, 'future_booking', true)`;

    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);
    await claimAs(clientA, result.claimRef, hash);

    const [link] = await testDb<{ is_primary: boolean }[]>`
      select is_primary from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id} and customer_id = ${claim!.customer_id}
    `;
    expect(link!.is_primary).toBe(false);
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("claiming an already-linked-to-the-same-account row is idempotent, no duplicate link row", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });

    const first = await claimAs(clientA, result.claimRef, hash);
    expect(first.error).toBeNull();
    const second = await claimAs(clientA, result.claimRef, hash);
    // The claim row is already consumed, so a second attempt fails
    // generically (see BROWSER CAPABILITY tests) — but critically, it
    // must never have produced a SECOND link row for the same
    // (tenant, user, customer).
    void second;

    const links = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links
      where tenant_id = ${tenant.id} and user_id = ${claimUserA.id} and customer_id = (select customer_id from booking_account_claims where appointment_id = ${result.appointmentReference})
    `;
    expect(links[0]!.count).toBe("1");
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("a target that becomes linked to a DIFFERENT account AFTER the claim was issued is never transferred at completion time", async () => {
    const phone = uniquePhone();
    const [preLinkedCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, email, status) values (${tenant.id}, 'Already Owned', ${phone}, ${claimUserA.email}, 'active') returning id
    `;

    // The row is UNLINKED and history-free at match time, so 2G.3.1A's
    // isolation logic does not divert this booking to a fresh row — it
    // correctly reuses this one, matching ordinary phone+name behavior.
    const { hash } = newSecret();
    const result = await bookDirect({
      email: claimUserA.email,
      claimSecretHash: hash,
      fullName: "Already Owned",
      phone,
    });

    // Only AFTER the claim exists does the row become linked to someone
    // else — e.g. a separate salon-assisted link, or an authenticated
    // future-booking auto-link, landing in the window between this
    // booking and the guest actually completing their claim. This is
    // exactly the remaining race claim_my_recent_booking's own
    // already-linked-elsewhere check exists for; isolation at match time
    // and this check at completion time cover two different windows.
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${existingLinkUser.id}, ${tenant.id}, ${preLinkedCustomer!.id}, 'salon_assisted', true)`;

    const { error } = await claimAs(clientA, result.claimRef, hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");

    const links = await testDb<{ user_id: string }[]>`
      select user_id from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${preLinkedCustomer!.id} and deleted_at is null
    `;
    expect(links.map((l) => l.user_id)).toEqual([existingLinkUser.id]);

    // preLinkedCustomer now has a real appointment row against it (the
    // guest booking above) — left for afterAll's cleanupTenants, which
    // already deletes appointment_items/appointments before customers
    // in the correct order for the whole tenant.
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${preLinkedCustomer!.id}`;
  });
});

describe("concurrency", () => {
  it("two simultaneous completion attempts against the same claim: exactly one succeeds, exactly one link row, exactly one audit event", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);

    const [r1, r2] = await Promise.all([claimAs(clientA, result.claimRef, hash), claimAs(clientA, result.claimRef, hash)]);
    const outcomes = [r1, r2];
    const successes = outcomes.filter((r) => r.error === null);
    const failures = outcomes.filter((r) => r.error !== null);
    expect(successes.length).toBe(1);
    expect(failures.length).toBe(1);
    expect(failures[0]!.error!.code).toBe("AC010");

    const links = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${claim!.customer_id} and deleted_at is null
    `;
    expect(links[0]!.count).toBe("1");

    const auditRows = await testDb<{ count: string }[]>`
      select count(*)::text as count from audit_logs where tenant_id = ${tenant.id} and action = 'customer_account_link.claimed' and entity_id = ${claim!.customer_id}
    `;
    expect(auditRows[0]!.count).toBe("1");

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("a claim racing a simultaneous authenticated future booking for the same user preserves the single-primary invariant", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });

    const otherBookingPhone = uniquePhone();
    const [otherResult] = await Promise.all([
      bookDirect({
        email: null,
        claimSecretHash: null,
        customerAccountUserId: claimUserA.id,
        phone: otherBookingPhone,
        fullName: "Concurrent Self Booking",
      }),
      claimAs(clientA, result.claimRef, hash),
    ]);
    void otherResult;

    const primaries = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links
      where tenant_id = ${tenant.id} and user_id = ${claimUserA.id} and deleted_at is null and is_primary = true
    `;
    expect(primaries[0]!.count).toBe("1");

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });
});

describe("mutation impact", () => {
  it("before claim: the appointment is not visible to the eventual claimer; after a successful claim: ordinary customer ownership applies", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });

    const before = await clientA.rpc("get_my_appointments");
    expect((before.data as unknown as { appointmentId: string }[]).some((a) => a.appointmentId === result.appointmentReference)).toBe(false);

    await claimAs(clientA, result.claimRef, hash);

    const after = await clientA.rpc("get_my_appointments");
    expect((after.data as unknown as { appointmentId: string }[]).some((a) => a.appointmentId === result.appointmentReference)).toBe(true);

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("a failed/partial claim attempt never grants access", async () => {
    const { hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });

    const forged = newSecret().hash;
    const failedAttempt = await claimAs(clientA, result.claimRef, forged);
    expect(failedAttempt.error).not.toBeNull();

    const { data } = await clientA.rpc("get_my_appointments");
    expect((data as unknown as { appointmentId: string }[]).some((a) => a.appointmentId === result.appointmentReference)).toBe(false);
  });
});

describe("enumeration", () => {
  it("every rejection reason (forged, missing, expired, already-claimed-by-another) returns the identical generic code", async () => {
    const forged = await claimAs(clientA, crypto.randomUUID(), newSecret().hash);

    const missing = await claimAs(clientA, null, "");

    const { hash: expiredHash } = newSecret();
    const expiredBooking = await bookDirect({ email: claimUserA.email, claimSecretHash: expiredHash });
    await testDb`update booking_account_claims set expires_at = now() - interval '1 minute' where appointment_id = ${expiredBooking.appointmentReference}`;
    const expired = await claimAs(clientA, expiredBooking.claimRef, expiredHash);

    const { hash: ownedHash } = newSecret();
    const ownedPhone = uniquePhone();
    const [preLinked] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, email, status) values (${tenant.id}, 'Enum Owned', ${ownedPhone}, ${claimUserA.email}, 'active') returning id
    `;
    // Row is unlinked at match time (isolation doesn't divert it), then
    // gets linked afterward — same reasoning as the LINK suite's own
    // "becomes linked after the claim was issued" test.
    const ownedBooking = await bookDirect({
      email: claimUserA.email,
      claimSecretHash: ownedHash,
      fullName: "Enum Owned",
      phone: ownedPhone,
    });
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${existingLinkUser.id}, ${tenant.id}, ${preLinked!.id}, 'salon_assisted', true)`;
    const ownedByOther = await claimAs(clientA, ownedBooking.claimRef, ownedHash);

    for (const result of [forged, missing, expired, ownedByOther]) {
      expect(result.error).not.toBeNull();
      expect(result.error!.code).toBe("AC010");
    }
    // Same message too, not just the same code — the UI-facing text must
    // carry no distinguishing signal either.
    const messages = new Set([forged, missing, expired, ownedByOther].map((r) => r.error!.message));
    expect(messages.size).toBe(1);

    // preLinked now has a real appointment row against it — left for
    // afterAll's cleanupTenants (same reasoning as the LINK suite above).
    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${preLinked!.id}`;
  });

  it("the audit event for a successful claim never carries the raw secret, its hash, the claim_ref, or the email snapshot", async () => {
    const { raw, hash } = newSecret();
    const result = await bookDirect({ email: claimUserA.email, claimSecretHash: hash });
    const claim = await getClaimRow(result.appointmentReference);
    await claimAs(clientA, result.claimRef, hash);

    const [auditRow] = await testDb<{ before: unknown; after: unknown; action: string }[]>`
      select before, after, action from audit_logs where tenant_id = ${tenant.id} and action = 'customer_account_link.claimed' and entity_id = ${claim!.customer_id}
    `;
    expect(auditRow).toBeTruthy();
    const serialized = JSON.stringify(auditRow);
    expect(serialized).not.toContain(raw);
    expect(serialized).not.toContain(hash);
    expect(serialized).not.toContain(result.claimRef!);
    expect(serialized).not.toContain(claimUserA.email);

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });
});

describe("security", () => {
  it("booking_account_claims has zero anon/authenticated table grants", async () => {
    // service_role is deliberately excluded here — its
    // MAINTAIN/REFERENCES/TRIGGER/TRUNCATE schema-maintenance baseline is
    // PROD's own pre-existing default on every table (see
    // security-grants-regression.test.ts's own "service_role has zero
    // table grants beyond the schema-maintenance baseline", which already
    // covers this table too); anon/authenticated/PUBLIC have no such
    // baseline, so any row for them here is a real, unexpected grant.
    const rows = await testDb<{ grantee: string; privilege_type: string }[]>`
      select grantee, privilege_type from information_schema.role_table_grants
      where table_schema = 'public' and table_name = 'booking_account_claims'
        and grantee in ('anon', 'authenticated', 'PUBLIC')
    `;
    expect(rows).toEqual([]);
  });

  it("private.upsert_booking_claim and private.claim_my_recent_booking have zero PUBLIC/anon/authenticated grants", async () => {
    const rows = await testDb<{ name: string; proacl: string[] | null }[]>`
      select p.proname as name, p.proacl
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname = 'private' and p.proname in ('upsert_booking_claim', 'claim_my_recent_booking')
    `;
    expect(rows.length).toBe(2);
    for (const row of rows) {
      expect(row.proacl, `${row.name} should be owner-only`).toEqual(["postgres=X/postgres"]);
    }
  });

  it("public.claim_my_recent_booking is granted to authenticated only, not anon", async () => {
    const { error: anonError } = await anonClient().rpc("claim_my_recent_booking", {
      p_claim_ref: crypto.randomUUID(),
      p_claim_secret_hash: "x",
    });
    expect(anonError!.code).toBe("42501");
  });

  it("booking_gateway's effective privilege surface is still exactly create_guest_booking", async () => {
    const rows = await testDb<{ schema: string; name: string; can_execute: boolean }[]>`
      select n.nspname as schema, p.proname as name, has_function_privilege('booking_gateway', p.oid, 'EXECUTE') as can_execute
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
      where n.nspname in ('public', 'private') and not exists (select 1 from pg_depend d where d.objid = p.oid and d.deptype = 'e')`;
    const executable = rows.filter((r) => r.can_execute).map((r) => `${r.schema}.${r.name}`);
    expect(executable).toEqual(["public.create_guest_booking"]);
  });
});

describe("legacy — no self-service claim", () => {
  it("a pre-2G.3-style legacy customer row with a matching current email is NOT linked by any code path", async () => {
    // Simulates a historical guest-booking customer row created before
    // this migration — no booking_account_claims row exists for it at
    // all (this project never backfills one), and its current email
    // happens to equal an authenticated user's email — the exact
    // scenario 2G.3.0 rejected as insufficient identity evidence.
    const [legacyCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, email, status)
      values (${tenant.id}, 'Legacy Guest', ${uniquePhone()}, ${claimUserA.email}, 'active')
      returning id
    `;

    // No claim exists for this row — any secret an attacker or the
    // legitimate email owner could present fails identically to a
    // forged claim. There is no alternate "search by email" RPC at all.
    const { error } = await claimAs(clientA, crypto.randomUUID(), newSecret().hash);
    expect(error).not.toBeNull();
    expect(error!.code).toBe("AC010");

    const links = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${legacyCustomer!.id}
    `;
    expect(links[0]!.count).toBe("0");

    await testDb`delete from customers where id = ${legacyCustomer!.id}`;
  });
});

describe("legacy — new-row isolation for claim-opt-in bookings (Faz 2G.3.1A)", () => {
  it("a claim-opt-in booking that phone+name-matches a HISTORIED legacy row gets a FRESH customer row instead of reusing it", async () => {
    const phone = uniquePhone();
    const [legacyCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, status) values (${tenant.id}, 'Isolation Legacy Guest', ${phone}, 'active') returning id
    `;
    const pastStart = new Date(Date.now() - 30 * 86400000);
    const pastEnd = new Date(pastStart.getTime() + 30 * 60000);
    const [legacyAppt] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at)
      values (${tenant.id}, ${branchId}, ${legacyCustomer!.id}, 'completed', ${pastStart.toISOString()}::timestamptz, ${pastEnd.toISOString()}::timestamptz) returning id
    `;
    await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
      values (${tenant.id}, ${legacyAppt!.id}, ${serviceId}, ${staffId}, ${pastStart.toISOString()}::timestamptz, ${pastEnd.toISOString()}::timestamptz, 30, 250, 1)`;

    const { hash } = newSecret();
    const newBooking = await bookDirect({
      email: claimUserA.email,
      claimSecretHash: hash,
      fullName: "Isolation Legacy Guest",
      phone,
    });

    const [newApptRow] = await testDb<{ customer_id: string }[]>`select customer_id from appointments where id = ${newBooking.appointmentReference}`;
    expect(newApptRow!.customer_id).not.toBe(legacyCustomer!.id);

    const { error } = await claimAs(clientA, newBooking.claimRef, hash);
    expect(error).toBeNull();

    const { data } = await clientA.rpc("get_my_appointments");
    const appts = data as unknown as { appointmentId: string }[];
    expect(appts.some((a) => a.appointmentId === newBooking.appointmentReference)).toBe(true);
    expect(appts.some((a) => a.appointmentId === legacyAppt!.id)).toBe(false); // legacy history stays invisible

    const legacyLinks = await testDb<{ count: string }[]>`
      select count(*)::text as count from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${legacyCustomer!.id}
    `;
    expect(legacyLinks[0]!.count).toBe("0"); // legacy row itself never got linked

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and user_id = ${claimUserA.id}`;
  });

  it("a claim-opt-in booking that phone+name-matches a row ALREADY LINKED to another account also gets a fresh row, not the owned one", async () => {
    const phone = uniquePhone();
    const [ownedCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, status) values (${tenant.id}, 'Isolation Owned Guest', ${phone}, 'active') returning id
    `;
    await testDb`insert into customer_account_links (user_id, tenant_id, customer_id, claimed_via, is_primary) values (${existingLinkUser.id}, ${tenant.id}, ${ownedCustomer!.id}, 'salon_assisted', true)`;

    const { hash } = newSecret();
    const newBooking = await bookDirect({
      email: claimUserA.email,
      claimSecretHash: hash,
      fullName: "Isolation Owned Guest",
      phone,
    });

    const [newApptRow] = await testDb<{ customer_id: string }[]>`select customer_id from appointments where id = ${newBooking.appointmentReference}`;
    expect(newApptRow!.customer_id).not.toBe(ownedCustomer!.id);

    const { error } = await claimAs(clientA, newBooking.claimRef, hash);
    expect(error).toBeNull(); // succeeds against the FRESH row, not the owned one

    const ownedLinks = await testDb<{ user_id: string }[]>`
      select user_id from customer_account_links where tenant_id = ${tenant.id} and customer_id = ${ownedCustomer!.id} and deleted_at is null
    `;
    expect(ownedLinks.map((l) => l.user_id)).toEqual([existingLinkUser.id]); // untouched — still only existingLinkUser

    await testDb`delete from customer_account_links where tenant_id = ${tenant.id} and (customer_id = ${ownedCustomer!.id} or user_id = ${claimUserA.id})`;
  });
});

describe("non-claim guest regression (Faz 2G.3.1A)", () => {
  it("an ordinary guest booking WITHOUT claim opt-in still reuses a matching legacy row, unaffected by the new isolation logic", async () => {
    const phone = uniquePhone();
    const [legacyCustomer] = await testDb<{ id: string }[]>`
      insert into customers (tenant_id, full_name, phone, status) values (${tenant.id}, 'Regression Legacy Guest', ${phone}, 'active') returning id
    `;
    const pastStart = new Date(Date.now() - 10 * 86400000);
    const pastEnd = new Date(pastStart.getTime() + 30 * 60000);
    await testDb`insert into appointments (tenant_id, branch_id, customer_id, status, scheduled_start_at, scheduled_end_at) values (${tenant.id}, ${branchId}, ${legacyCustomer!.id}, 'completed', ${pastStart.toISOString()}::timestamptz, ${pastEnd.toISOString()}::timestamptz)`;

    // No email, no claimSecretHash — ordinary guest booking, exactly the
    // pre-2G.3.1 behavior this must not change.
    const newBooking = await bookDirect({ email: null, claimSecretHash: null, fullName: "Regression Legacy Guest", phone });
    const [newApptRow] = await testDb<{ customer_id: string }[]>`select customer_id from appointments where id = ${newBooking.appointmentReference}`;
    expect(newApptRow!.customer_id).toBe(legacyCustomer!.id);
  });
});
