/**
 * Faz LAUNCH.1B — how the worker treats what the claim hands it, with a recording fake Supabase client (no
 * database, no network): a job of a type this code does not know is never rendered, never begun and never sent; a
 * claim from a database that predates the lifecycle migration (no type field) is the confirmation, as it always was.
 */
import { describe, expect, it, vi } from "vitest";
import { processCustomerNotificationBatch } from "@/lib/modules/customer-notifications/confirmation-email-worker";
import type { OutboundEmail, SendMailFn } from "@/lib/email/smtp-transport";

const BASE_JOB = {
  jobId: "00000000-0000-4000-8000-000000000001",
  lockToken: "00000000-0000-4000-8000-0000000000aa",
  attemptCount: 0,
  recipientEmail: "alici@example.test",
  greetingName: "Ayşe",
  salonName: "Örnek Salon",
  tenantSlug: "ornek-salon",
  tenantTimezone: "Europe/Istanbul",
  appointmentStartAt: "2026-10-27T07:00:00.000Z",
  serviceNames: ["Saç Kesimi"],
  staffNames: [],
  contactPhone: null,
  locationUrl: null,
};

function fakeClient(jobs: unknown[]) {
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const rpc = vi.fn(async (name: string, args: Record<string, unknown>) => {
    calls.push({ name, args });
    if (name === "claim_customer_notification_jobs") return { data: { activeTenantCount: 1, jobs }, error: null };
    if (name === "begin_customer_notification_send") return { data: true, error: null };
    if (name === "record_customer_notification_result") return { data: { applied: true, status: args.p_disposition }, error: null };
    return { data: null, error: { code: "XX000" } };
  });
  return { client: { rpc } as never, calls };
}

function recordingSend(): { send: SendMailFn; sent: OutboundEmail[] } {
  const sent: OutboundEmail[] = [];
  const send: SendMailFn = async (message) => {
    sent.push(message);
    return { outcome: "sent", provider: "google_workspace_smtp", providerMessageId: "<id@salonos.test>" };
  };
  return { send, sent };
}

describe("claimed jobs of an unknown or missing type", () => {
  it("an UNKNOWN type is never begun, rendered or sent", async () => {
    const { client, calls } = fakeClient([{ ...BASE_JOB, notificationType: "appointment_sms" }]);
    const { send, sent } = recordingSend();
    const result = await processCustomerNotificationBatch({ supabase: client, send });
    expect(sent).toHaveLength(0);
    expect(calls.map((call) => call.name)).toEqual(["claim_customer_notification_jobs"]);
    expect(result).toMatchObject({ claimed: 1, sent: 0, recordFailed: 1 });
  });

  it("a claim without a type field is the confirmation (a database that predates the lifecycle migration)", async () => {
    const { client } = fakeClient([{ ...BASE_JOB }]);
    const { send, sent } = recordingSend();
    const result = await processCustomerNotificationBatch({ supabase: client, send });
    expect(result.sent).toBe(1);
    expect(sent[0]!.subject).toBe("Randevunuz Onaylandı — Örnek Salon");
  });

  it("each known type renders its own email", async () => {
    const expected: [string, RegExp][] = [
      ["appointment_confirmation", /^Randevunuz Onaylandı/],
      ["appointment_update", /^Randevunuz Güncellendi/],
      ["appointment_cancellation", /^Randevunuz İptal Edildi/],
      ["appointment_reminder_24h", /Randevunuz Var|Randevu Hatırlatması/],
    ];
    for (const [type, subject] of expected) {
      const { client } = fakeClient([{ ...BASE_JOB, notificationType: type }]);
      const { send, sent } = recordingSend();
      await processCustomerNotificationBatch({ supabase: client, send });
      expect(sent, type).toHaveLength(1);
      expect(sent[0]!.subject, type).toMatch(subject);
    }
  });

  it("a malformed address is skipped, never sent, whatever the type", async () => {
    const { client, calls } = fakeClient([{ ...BASE_JOB, notificationType: "appointment_update", recipientEmail: "a@b.test,c@d.test" }]);
    const { send, sent } = recordingSend();
    await processCustomerNotificationBatch({ supabase: client, send });
    expect(sent).toHaveLength(0);
    expect(calls.find((call) => call.name === "record_customer_notification_result")!.args).toMatchObject({
      p_disposition: "skipped",
      p_skip_reason: "invalid_recipient",
    });
  });
});
