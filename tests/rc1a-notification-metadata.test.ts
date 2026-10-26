import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { admin, asAuthenticatedUser, cleanupTenants, cleanupUsers, createBranch, createService, createStaffMember, createTestTenant, createTestUser, linkServiceBranch, linkStaffBranch, linkStaffService, testDb, type TestUser } from "./helpers";
import { buildCustomerNotificationEmail, type CustomerNotificationEmailInput } from "@/lib/email/templates/appointment-notifications";
import { buildAppointmentConfirmationEmail } from "@/lib/email/templates/appointment-confirmation";
import { cleanPreparationNote } from "@/lib/email/templates/appointment-email-layout";
import { processCustomerNotificationBatch } from "@/lib/modules/customer-notifications/confirmation-email-worker";
import type { OutboundEmail, SendMailFn } from "@/lib/email/smtp-transport";

/**
 * RC.1A - the preparation note in the LAUNCH.1B e-mails. Pure template rules first, then the claim payload against the real
 * database function. Synthetic data only; nothing is ever sent.
 */

const base: CustomerNotificationEmailInput = {
  salonName: "Emel Beauty Bar",
  greetingName: "Ayşe",
  appointmentStartAt: "2026-11-05T07:00:00.000Z",
  tenantTimezone: "Asia/Nicosia",
  serviceNames: ["Kaş Laminasyonu"],
  staffNames: ["Emel Kaynakkan"],
  contactPhone: "+905421234567",
  locationUrl: null,
  referenceInstant: "2026-11-04T07:00:00.000Z",
  rebookUrl: "https://example.test/book/emel",
};
const NOTE = "Lütfen kaşlarınızı almadan geliniz.";

describe("templates: one concise preparation line, confirmation and reminder only", () => {
  it("confirmation and reminder carry it in the panel and in the text; update and cancellation never do", () => {
    for (const type of ["appointment_confirmation", "appointment_reminder_24h"] as const) {
      const m = buildCustomerNotificationEmail(type, { ...base, preparationNote: NOTE });
      expect(m.text).toContain(`Randevu öncesi: ${NOTE}`);
      expect(m.html).toContain("RANDEVU ÖNCESİ");
      expect(m.html).toContain(NOTE);
    }
    for (const type of ["appointment_update", "appointment_cancellation"] as const) {
      const m = buildCustomerNotificationEmail(type, { ...base, preparationNote: NOTE });
      expect(m.text + m.html).not.toContain(NOTE);
      expect(m.html).not.toContain("RANDEVU ÖNCESİ");
    }
  });

  it("no note, an empty note or a whitespace note changes nothing: the output equals the output without the field", () => {
    for (const type of ["appointment_confirmation", "appointment_reminder_24h", "appointment_update", "appointment_cancellation"] as const) {
      const without = buildCustomerNotificationEmail(type, base);
      for (const value of [undefined, null, "", "   ", "\n\t"]) {
        const m = buildCustomerNotificationEmail(type, { ...base, preparationNote: value });
        expect(m, `${type} ${JSON.stringify(value)}`).toEqual(without);
      }
    }
    expect(buildAppointmentConfirmationEmail(base).html).not.toContain("RANDEVU ÖNCESİ");
  });

  it("the line is single-line, control-character-free, at most 240 characters, and HTML-escaped", () => {
    expect(cleanPreparationNote("a\nb\r\nc\t d")).toBe("a b c d");
    expect(cleanPreparationNote("x".repeat(500))!.length).toBeLessThanOrEqual(240);
    expect(cleanPreparationNote("   ")).toBeNull();
    expect(cleanPreparationNote(null)).toBeNull();
    const m = buildCustomerNotificationEmail("appointment_confirmation", { ...base, preparationNote: '<script>alert(1)</script> & "x"' });
    expect(m.html).not.toContain("<script>");
    expect(m.html).toContain("&lt;script&gt;");
  });

  it("the layout adds nothing else: the same sections in the same order, the note just before the contact line", () => {
    const m = buildCustomerNotificationEmail("appointment_confirmation", { ...base, preparationNote: NOTE });
    const order = ["HİZMET", "PERSONEL", "RANDEVU ÖNCESİ", "İLETİŞİM"].map((s) => m.html.indexOf(s));
    expect(order.every((i) => i > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
  });
});

describe("the claim payload (real function): at most two distinct notes in booking order, only services.preparation_note", () => {
  const users: TestUser[] = [];
  let tenantId: string;
  let slug: string;
  let owner: TestUser;
  const svc: string[] = [];
  let staffId: string;
  let foreignSvc: string;

  beforeAll(async () => {
    owner = await createTestUser("rcn-owner");
    users.push(owner);
    const t = await createTestTenant(`rcn-${Math.random().toString(36).slice(2, 7)}`, owner.id);
    tenantId = t.id;
    slug = t.slug;
    await testDb`update tenants set timezone = 'Asia/Nicosia' where id = ${tenantId}`;
    const branch = await createBranch(tenantId, "Merkez");
    const staff = await createStaffMember(tenantId, "Emel Kaynakkan");
    staffId = staff.id;
    await linkStaffBranch(staff.id, branch);
    for (const [i, note] of ["Birinci hazırlık.", "İkinci hazırlık.", "Üçüncü hazırlık.", null, "Birinci hazırlık."].entries()) {
      const s = await createService(tenantId, `Hizmet ${i}`, 30, 100);
      svc.push(s.id);
      await linkServiceBranch(s.id, branch);
      await linkStaffService(staff.id, s.id);
      await testDb`update services set preparation_note = ${note}, description = 'IC-ACIKLAMA', aftercare_note = 'SONRA-NOTU' where id = ${s.id}`;
    }
    const other = await createTestTenant(`rcn-o-${Math.random().toString(36).slice(2, 7)}`, (await createTestUser("rcn-other")).id);
    const foreign = await createService(other.id, "Yabanci Hizmet", 30, 1);
    foreignSvc = foreign.id;
    await testDb`update services set preparation_note = 'YABANCI-HAZIRLIK' where id = ${foreign.id}`;
    tenants.push(tenantId, other.id);
    await asAuthenticatedUser(owner.id, (sql) => sql`select public.set_customer_notification_setting(${tenantId}::uuid, 'appointment_confirmation', true)`);
  }, 120_000);

  const tenants: string[] = [];
  afterAll(async () => {
    await cleanupTenants(tenants);
    await cleanupUsers(users.map((u) => u.id));
  }, 120_000);

  async function claimFor(serviceIds: string[], extra?: { corruptForeign?: boolean }): Promise<Record<string, unknown>> {
    const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, email, notes) values (${tenantId}, 'Sentetik', ${`m${Math.random().toString(36).slice(2, 6)}@example.test`}, 'MUSTERI-NOTU') returning id`;
    const [ap] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, source, notes, scheduled_start_at, scheduled_end_at)
      values (${tenantId}, (select id from branches where tenant_id = ${tenantId} limit 1), ${c!.id}, 'scheduled', 'internal', 'RANDEVU-NOTU', now() + interval '3 days', now() + interval '4 days') returning id`;
    for (const [i, s] of serviceIds.entries()) {
      await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
        values (${tenantId}, ${ap!.id}, ${s}, ${staffId}, now() + interval '3 days' + make_interval(mins => ${i * 30}), now() + interval '3 days' + make_interval(mins => ${i * 30 + 30}), 30, 100, ${i + 1})`;
    }
    if (extra?.corruptForeign) {
      await testDb.begin(async (tx) => {
        await tx`set local session_replication_role = replica`;
        await tx`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
          values (${tenantId}, ${ap!.id}, ${foreignSvc}, ${staffId}, now() + interval '3 days 2 hours', now() + interval '3 days 3 hours', 30, 1, 99)`;
        // and an item row that itself claims the other salon (tenant, service and note all foreign) inside this appointment
        await tx`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
          values ((select tenant_id from services where id = ${foreignSvc}), ${ap!.id}, ${foreignSvc}, ${staffId}, now() + interval '3 days 4 hours', now() + interval '3 days 5 hours', 30, 1, 98)`;
      });
    }
    await testDb`update appointments set status = 'confirmed' where id = ${ap!.id}`;
    const res = await testDb<{ result: { jobs: Record<string, unknown>[] } }[]>`select private.claim_customer_notification_jobs(50, 180) as result`;
    return res[0]!.result.jobs.find((j) => j.tenantSlug === slug && (j.serviceNames as string[]).length >= 1 && (j.appointmentStartAt as string) !== undefined && JSON.stringify(j.serviceNames) === JSON.stringify(serviceIds.length ? (j.serviceNames as string[]) : []) && j.recipientEmail !== undefined)!;
  }

  it("no service has a note -> null", async () => {
    const job = await claimFor([svc[3]!]);
    expect(job.preparationNote).toBeNull();
  });

  it("one note -> that note; three notes -> the first two in booking order; a repeated note appears once; the payload holds no other note", async () => {
    expect((await claimFor([svc[0]!])).preparationNote).toBe("Birinci hazırlık.");
    expect((await claimFor([svc[0]!, svc[1]!, svc[2]!])).preparationNote).toBe("Birinci hazırlık. İkinci hazırlık.");
    expect((await claimFor([svc[3]!, svc[4]!, svc[0]!])).preparationNote).toBe("Birinci hazırlık."); // svc[4] repeats svc[0]'s note
    const job = await claimFor([svc[1]!, svc[0]!]);
    expect(job.preparationNote).toBe("İkinci hazırlık. Birinci hazırlık.");
    const text = JSON.stringify(job);
    for (const secret of ["IC-ACIKLAMA", "SONRA-NOTU", "RANDEVU-NOTU", "MUSTERI-NOTU", "Üçüncü"]) expect(text, secret).not.toContain(secret);
  });

  it("another salon's service wearing this appointment contributes no note", async () => {
    const job = await claimFor([svc[0]!], { corruptForeign: true });
    expect(job.preparationNote).toBe("Birinci hazırlık.");
    expect(JSON.stringify(job)).not.toContain("YABANCI");
  });

  it("end to end through the worker: the confirmation that is rendered and handed to the transport carries the note, in the text and the html", async () => {
    const calls: OutboundEmail[] = [];
    const send: SendMailFn = async (message) => {
      calls.push(message);
      return { outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "<fake@salonos.test>" };
    };
    const [c] = await testDb<{ id: string }[]>`insert into customers (tenant_id, full_name, email) values (${tenantId}, 'Worker Musterisi', 'worker@example.test') returning id`;
    const [ap] = await testDb<{ id: string }[]>`
      insert into appointments (tenant_id, branch_id, customer_id, status, source, scheduled_start_at, scheduled_end_at)
      values (${tenantId}, (select id from branches where tenant_id = ${tenantId} limit 1), ${c!.id}, 'scheduled', 'internal', now() + interval '2 days', now() + interval '2 days 1 hour') returning id`;
    for (const [i, s] of [svc[0]!, svc[1]!].entries()) {
      await testDb`insert into appointment_items (tenant_id, appointment_id, service_id, staff_member_id, scheduled_start_at, scheduled_end_at, duration_minutes, price, sequence)
        values (${tenantId}, ${ap!.id}, ${s}, ${staffId}, now() + interval '2 days' + make_interval(mins => ${i * 30}), now() + interval '2 days' + make_interval(mins => ${i * 30 + 30}), 30, 100, ${i + 1})`;
    }
    await testDb`update appointments set status = 'confirmed' where id = ${ap!.id}`;
    const result = await processCustomerNotificationBatch({ supabase: admin, send, batchSize: 20 });
    expect(result.sent).toBeGreaterThanOrEqual(1);
    const mail = calls.find((m) => m.to === "worker@example.test")!;
    expect(mail).toBeTruthy();
    expect(mail.text).toContain("Randevu öncesi: Birinci hazırlık. İkinci hazırlık.");
    expect(mail.html).toContain("RANDEVU ÖNCESİ");
    expect(mail.text + mail.html).not.toContain("IC-ACIKLAMA");
    expect(mail.text + mail.html).not.toContain("SONRA-NOTU");
  });
});
