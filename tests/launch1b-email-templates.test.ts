import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { buildAppointmentConfirmationEmail } from "@/lib/email/templates/appointment-confirmation";
import {
  buildAppointmentCancellationEmail,
  buildAppointmentReminderEmail,
  buildAppointmentUpdateEmail,
  buildCustomerNotificationEmail,
  CUSTOMER_NOTIFICATION_TYPES,
  type CustomerNotificationEmailInput,
} from "@/lib/email/templates/appointment-notifications";
import { formatAppointmentDisplay, localDayDifference, sanitizeContactPhone } from "@/lib/email/templates/appointment-email-layout";

/**
 * Faz LAUNCH.1B — the four customer emails as pure functions: content, Turkish wording,
 * the salon's timezone, escaping, and what must never appear.
 */

const BASE: CustomerNotificationEmailInput = {
  salonName: "Örnek Güzellik Salonu",
  greetingName: "Ayşe",
  appointmentStartAt: "2026-10-27T07:00:00.000Z", // 10:00 in Europe/Istanbul
  tenantTimezone: "Europe/Istanbul",
  serviceNames: ["Saç Kesimi", "Fön"],
  staffNames: ["Personel Bir"],
  contactPhone: "+90 392 555 01 02",
  locationUrl: "https://share.google/SampleSalonLink0001",
  referenceInstant: "2026-10-26T07:05:00.000Z",
  rebookUrl: "https://salon.example.com/book/ornek-salon",
};

describe("the confirmation email did not change (golden)", () => {
  it("is byte-identical to the NOTIF.1B output for the original inputs", () => {
    const golden = JSON.parse(readFileSync(path.join(__dirname, "fixtures/appointment-confirmation-golden.json"), "utf8"));
    const inputs = [
      { salonName: "Örnek Salon", greetingName: "Ayşe", appointmentStartAt: "2026-10-27T07:00:00.000Z", tenantTimezone: "Europe/Istanbul", serviceNames: ["Saç Kesimi"], locationUrl: "https://share.google/SampleSalonLink0001" },
      { salonName: "Gökhan İlhan Hair Studio", greetingName: "AYŞE-NUR", appointmentStartAt: "2026-03-29T00:30:00.000Z", tenantTimezone: "Europe/Nicosia", serviceNames: ["Fön", "Saç Kesimi <b>x</b>", "Bakım"], locationUrl: null },
      { salonName: "S", greetingName: null, appointmentStartAt: "2026-12-31T21:45:00.000Z", tenantTimezone: "Europe/Istanbul", serviceNames: [], locationUrl: "http://insecure.example/x" },
      { salonName: "A & B \"Salon\" 'x'", greetingName: "Zeynep Kaya", appointmentStartAt: "2027-01-05T09:15:00.000Z", tenantTimezone: "Europe/Istanbul", serviceNames: ["A", "B", "C", "D", "E", "F", "G", "H", "I", "J"], locationUrl: "https://maps.example.com/?q=1&r=2" },
    ];
    expect(inputs.map((input) => buildAppointmentConfirmationEmail(input))).toEqual(golden);
  });

  it("gains the staff name and the phone only when they are supplied", () => {
    const plain = buildAppointmentConfirmationEmail({ ...BASE, staffNames: undefined, contactPhone: undefined });
    expect(plain.text).not.toContain("Personel");
    expect(plain.text).not.toContain("İletişim");
    const rich = buildAppointmentConfirmationEmail(BASE);
    expect(rich.text).toContain("Personel: Personel Bir");
    expect(rich.text).toContain("İletişim: +90 392 555 01 02");
    expect(rich.html).toContain("PERSONEL");
  });
});

describe("update", () => {
  const mail = buildAppointmentUpdateEmail(BASE);
  it("says plainly that the appointment was changed and shows the CURRENT details", () => {
    expect(mail.subject).toBe("Randevunuz Güncellendi — Örnek Güzellik Salonu");
    expect(mail.text).toContain("Ayşe, randevunuz güncellendi");
    expect(mail.text).toContain("randevunuzda bir değişiklik yaptı");
    expect(mail.text).toContain("Güncel randevu bilgileriniz aşağıdadır");
    expect(mail.text).toContain("Salı, 27 Ekim 2026");
    expect(mail.text).toContain("Saat: 10:00");
    expect(mail.html).toContain("GÜNCEL TARİH VE SAAT");
  });
  it("the customer's name never appears in the subject or the preheader", () => {
    expect(mail.subject).not.toContain("Ayşe");
    expect(mail.html).toMatch(/<div style="display:none[^>]*>Randevunuz güncellendi · [^<]*<\/div>/);
  });
});

describe("cancellation", () => {
  it("says it was cancelled, references the date and time, and offers a way to book again", () => {
    const mail = buildAppointmentCancellationEmail(BASE);
    expect(mail.subject).toBe("Randevunuz İptal Edildi — Örnek Güzellik Salonu");
    expect(mail.text).toContain("Ayşe, randevunuz iptal edildi");
    expect(mail.text).toContain("Salı, 27 Ekim 2026");
    expect(mail.text).toContain("Saat: 10:00");
    expect(mail.text).toContain("Yeni randevu: https://salon.example.com/book/ornek-salon");
    expect(mail.html).toContain("Yeniden Randevu Al");
    expect(mail.html).toContain("İPTAL EDİLEN RANDEVU");
  });
  it("without a usable https rebook link it points to the salon instead, and renders no button", () => {
    for (const rebookUrl of [null, "http://insecure.example/book/x", "javascript:alert(1)"]) {
      const mail = buildAppointmentCancellationEmail({ ...BASE, rebookUrl });
      expect(mail.html).not.toContain("Yeniden Randevu Al");
      expect(mail.html).not.toContain("javascript:");
      expect(mail.text).toContain("lütfen salonla iletişime geçin");
    }
  });
});

describe("reminder", () => {
  it("says 'Yarın randevunuz var' when the appointment is on the salon's NEXT local day", () => {
    const mail = buildAppointmentReminderEmail(BASE);
    expect(mail.subject).toBe("Yarın Randevunuz Var — Örnek Güzellik Salonu");
    expect(mail.text).toContain("Ayşe, yarın randevunuz var");
    expect(mail.text).toContain("Salı, 27 Ekim 2026");
    expect(mail.text).toContain("Saat: 10:00");
    expect(mail.text).toContain("Hizmetler:");
  });
  it("says 'bugün' for the same local day and never claims 'yarın' for anything else", () => {
    const sameDay = buildAppointmentReminderEmail({ ...BASE, referenceInstant: "2026-10-27T02:00:00.000Z" }); // 05:00 local, same day
    expect(sameDay.subject).toBe("Bugün Randevunuz Var — Örnek Güzellik Salonu");
    const farAway = buildAppointmentReminderEmail({ ...BASE, referenceInstant: "2026-10-24T07:00:00.000Z" });
    expect(farAway.subject).toBe("Randevu Hatırlatması — Örnek Güzellik Salonu");
    expect(farAway.text).not.toMatch(/yarın/i);
  });
  it("the day word follows the SALON's calendar, not UTC and not the server", () => {
    // 21:30 UTC on Oct 26 is 00:30 on Oct 27 in Istanbul; the appointment is later on Oct 27 local.
    const mail = buildAppointmentReminderEmail({
      ...BASE,
      referenceInstant: "2026-10-26T21:30:00.000Z",
      appointmentStartAt: "2026-10-27T10:00:00.000Z",
    });
    expect(mail.subject).toBe("Bugün Randevunuz Var — Örnek Güzellik Salonu");
    expect(localDayDifference("2026-10-26T21:30:00.000Z", "2026-10-27T10:00:00.000Z", "Europe/Istanbul")).toBe(0);
    expect(localDayDifference("2026-10-26T21:30:00.000Z", "2026-10-27T10:00:00.000Z", "UTC")).toBe(1);
  });
});

describe("the salon's timezone, including Europe/Nicosia and the DST change", () => {
  it("renders local time from the instant, DST-correct", () => {
    // Cyprus: EET (UTC+2) before 2026-03-29 03:00 local, EEST (UTC+3) after.
    expect(formatAppointmentDisplay("2026-03-29T00:30:00.000Z", "Europe/Nicosia")).toEqual({ dateLine: "Pazar, 29 Mart 2026", time: "02:30" });
    expect(formatAppointmentDisplay("2026-03-29T01:30:00.000Z", "Europe/Nicosia")).toEqual({ dateLine: "Pazar, 29 Mart 2026", time: "04:30" });
    expect(formatAppointmentDisplay("2026-07-15T08:00:00.000Z", "Europe/Nicosia")).toEqual({ dateLine: "Çarşamba, 15 Temmuz 2026", time: "11:00" });
    expect(formatAppointmentDisplay("2026-12-15T08:00:00.000Z", "Europe/Nicosia")).toEqual({ dateLine: "Salı, 15 Aralık 2026", time: "10:00" });
  });
  it("the same instant reads differently in different salons (the process timezone is never used)", () => {
    expect(formatAppointmentDisplay("2026-07-15T08:00:00.000Z", "Europe/Istanbul").time).toBe("11:00");
    expect(formatAppointmentDisplay("2026-07-15T08:00:00.000Z", "Europe/London").time).toBe("09:00");
  });
});

describe("safety of every email", () => {
  const hostile: CustomerNotificationEmailInput = {
    ...BASE,
    salonName: "Salon <script>alert(1)</script> & \"Ortak\"\r\nBcc: x@evil.test",
    greetingName: "Ayşe<img src=x onerror=alert(1)>",
    serviceNames: ["Saç <b>Kesimi</b>", "Fön Bakım"],
    staffNames: ["Mehmet <i>Usta</i>"],
    contactPhone: "<script>0392</script>",
    locationUrl: "javascript:alert(1)",
  };

  it("escapes markup, strips header-injection characters from the subject, drops an unsafe phone and link", () => {
    for (const type of CUSTOMER_NOTIFICATION_TYPES) {
      const mail = buildCustomerNotificationEmail(type, hostile);
      expect(mail.subject, type).not.toMatch(/[\r\n]/);
      expect(mail.subject, type).not.toContain("Bcc:\n");
      expect(mail.html, type).not.toContain("<script>");
      expect(mail.html, type).not.toContain("<img src=x");
      expect(mail.html, type).not.toContain("<b>Kesimi</b>");
      expect(mail.html, type).not.toContain("javascript:");
      expect(mail.html, type).not.toContain("0392");
      expect(mail.html, type).toContain("&lt;script&gt;");
    }
  });

  it("never carries ids, prices, tracking or remote assets", () => {
    for (const type of CUSTOMER_NOTIFICATION_TYPES) {
      const mail = buildCustomerNotificationEmail(type, BASE);
      const all = `${mail.subject}\n${mail.html}\n${mail.text}`;
      expect(all, type).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(all, type).not.toMatch(/₺|\bTL\b|fiyat|price/i);
      expect(all, type).not.toMatch(/<img|<link|@import|<iframe|url\(http/i);
      expect(all, type).toMatch(/lütfen yanıtlamayınız/);
    }
  });

  it("dispatches by type and refuses an unknown one", () => {
    expect(buildCustomerNotificationEmail("appointment_update", BASE).subject).toContain("Güncellendi");
    expect(() => buildCustomerNotificationEmail("appointment_sms" as never, BASE)).toThrow(/unknown customer notification type/);
  });

  it("an invalid timezone or date throws (the worker records render_error; nothing is sent)", () => {
    expect(() => buildAppointmentReminderEmail({ ...BASE, tenantTimezone: "Mars/Phobos" })).toThrow();
    expect(() => buildAppointmentUpdateEmail({ ...BASE, appointmentStartAt: "not-a-date" })).toThrow();
  });

  it("contact phone: only a dialable number survives", () => {
    expect(sanitizeContactPhone("+90 392 555 01 02")).toBe("+90 392 555 01 02");
    expect(sanitizeContactPhone("0392-555-0102")).toBe("0392-555-0102");
    for (const bad of ["", "abc", "12", "<b>0392</b>", "tel:+90392", "0392 555 01 02 dahili: 5", null, undefined]) {
      expect(sanitizeContactPhone(bad as never), String(bad)).toBeNull();
    }
  });
});
