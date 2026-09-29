import { describe, expect, it } from "vitest";
import {
  buildAppointmentConfirmationEmail,
  formatAppointmentDisplay,
  formatGreetingName,
  type AppointmentConfirmationTemplateInput,
} from "@/lib/email/templates/appointment-confirmation";
import { sanitizeEmailLocationUrl } from "@/lib/email/location-url";

/**
 * Faz NOTIF.1A — the customer appointment-confirmation email's content:
 * matrix C (11-18) plus the location-link and greeting rules. Pure: no
 * database, no network, no environment.
 */

const SAMPLE_LOCATION = "https://share.google/SampleSalonLink0001";

function baseInput(overrides: Partial<AppointmentConfirmationTemplateInput> = {}): AppointmentConfirmationTemplateInput {
  return {
    salonName: "Gökhan İlhan Hair Studio",
    greetingName: "Ayşe",
    // 2026-10-07 11:30 UTC = 14:30 in Europe/Istanbul (UTC+3, no DST)
    appointmentStartAt: "2026-10-07T11:30:00.000Z",
    tenantTimezone: "Europe/Istanbul",
    serviceNames: ["Saç Kesimi"],
    locationUrl: SAMPLE_LOCATION,
    ...overrides,
  };
}

describe("subject and headline", () => {
  it("subject is exactly 'Randevunuz Onaylandı — <salon>'", () => {
    expect(buildAppointmentConfirmationEmail(baseInput()).subject).toBe("Randevunuz Onaylandı — Gökhan İlhan Hair Studio");
  });

  it("the HTML carries the salon name and a 'Ayşe, randevunuz onaylandı ✓' headline", () => {
    const { html } = buildAppointmentConfirmationEmail(baseInput());
    expect(html).toContain("Gökhan İlhan Hair Studio");
    // the check mark stays glued to the last word so it can never wrap onto a line of its own
    expect(html).toMatch(/Ayşe, randevunuz <span[^>]*>onaylandı <span[^>]*>&#10003;<\/span><\/span>/);
  });

  it("a control character in the salon name can never reach the subject header", () => {
    const { subject } = buildAppointmentConfirmationEmail(
      baseInput({ salonName: "Evil\r\nBcc: attacker@example.test\u0007 Salon" }),
    );
    expect(subject).not.toMatch(/[\r\n\x00-\x08\x0b-\x1f\x7f]/);
    expect(subject.startsWith("Randevunuz Onaylandı — Evil")).toBe(true);
  });

  it("an empty/whitespace salon name falls back rather than producing an empty subject tail", () => {
    expect(buildAppointmentConfirmationEmail(baseInput({ salonName: "  \n " })).subject).toBe("Randevunuz Onaylandı — Salon");
  });

  // Faz NOTIF.1B, test 6: the customer's name lives only inside the opened
  // email (the headline), never in the subject or preheader — both can
  // surface in a lock-screen/notification preview before the email opens.
  it("the subject never contains the customer's name, regardless of greetingName", () => {
    const { subject } = buildAppointmentConfirmationEmail(baseInput({ greetingName: "Ayşe" }));
    expect(subject).toBe("Randevunuz Onaylandı — Gökhan İlhan Hair Studio");
    expect(subject).not.toContain("Ayşe");
  });

  it("the preheader never contains the customer's name either", () => {
    const { html } = buildAppointmentConfirmationEmail(baseInput({ greetingName: "Ayşe" }));
    const preheaderMatch = html.match(/mso-hide:all;">([^<]*)</);
    expect(preheaderMatch?.[1]).not.toContain("Ayşe");
  });
});

describe("C11. tenant-local date and time (never the server's timezone)", () => {
  it("renders the same instant in the salon's own timezone", () => {
    expect(formatAppointmentDisplay("2026-10-07T11:30:00.000Z", "Europe/Istanbul")).toEqual({
      dateLine: "Çarşamba, 7 Ekim 2026",
      time: "14:30",
    });
    expect(formatAppointmentDisplay("2026-10-07T11:30:00.000Z", "America/New_York")).toEqual({
      dateLine: "Çarşamba, 7 Ekim 2026",
      time: "07:30",
    });
  });

  it("the local calendar date (and so the weekday) follows the timezone across midnight", () => {
    // 22:30 UTC on Wednesday is 01:30 on Thursday in Istanbul.
    expect(formatAppointmentDisplay("2026-10-07T22:30:00.000Z", "Europe/Istanbul")).toEqual({
      dateLine: "Perşembe, 8 Ekim 2026",
      time: "01:30",
    });
    expect(formatAppointmentDisplay("2026-10-07T22:30:00.000Z", "UTC")).toEqual({
      dateLine: "Çarşamba, 7 Ekim 2026",
      time: "22:30",
    });
  });

  it("every weekday and month name is the Turkish one", () => {
    const days = [
      ["2026-10-04T09:00:00Z", "Pazar, 4 Ekim 2026"],
      ["2026-10-05T09:00:00Z", "Pazartesi, 5 Ekim 2026"],
      ["2026-10-06T09:00:00Z", "Salı, 6 Ekim 2026"],
      ["2026-10-07T09:00:00Z", "Çarşamba, 7 Ekim 2026"],
      ["2026-10-08T09:00:00Z", "Perşembe, 8 Ekim 2026"],
      ["2026-10-09T09:00:00Z", "Cuma, 9 Ekim 2026"],
      ["2026-10-10T09:00:00Z", "Cumartesi, 10 Ekim 2026"],
    ] as const;
    for (const [iso, expected] of days) {
      expect(formatAppointmentDisplay(iso, "Europe/Istanbul").dateLine).toBe(expected);
    }
    const months = ["Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran", "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık"];
    months.forEach((name, index) => {
      const iso = new Date(Date.UTC(2027, index, 15, 9, 0, 0)).toISOString();
      expect(formatAppointmentDisplay(iso, "Europe/Istanbul").dateLine).toContain(` 15 ${name} 2027`);
    });
  });

  it("an invalid timezone makes rendering throw (the worker turns that into a non-sent failure, never a UTC fallback)", () => {
    expect(() => buildAppointmentConfirmationEmail(baseInput({ tenantTimezone: "Not/AZone" }))).toThrow();
  });
});

describe("C12. DST-safe", () => {
  it("autumn fall-back in Europe/Berlin: the two 02:30 wall times are two different instants and both render correctly", () => {
    // 2026-10-25: clocks go 03:00 CEST -> 02:00 CET.
    expect(formatAppointmentDisplay("2026-10-25T00:30:00.000Z", "Europe/Berlin").time).toBe("02:30"); // CEST
    expect(formatAppointmentDisplay("2026-10-25T01:30:00.000Z", "Europe/Berlin").time).toBe("02:30"); // CET
    expect(formatAppointmentDisplay("2026-10-25T02:30:00.000Z", "Europe/Berlin").time).toBe("03:30"); // CET
  });

  it("spring-forward in Europe/Berlin: 01:59 CET is followed by 03:00 CEST", () => {
    // 2026-03-29: clocks go 02:00 CET -> 03:00 CEST.
    expect(formatAppointmentDisplay("2026-03-29T00:59:00.000Z", "Europe/Berlin")).toEqual({
      dateLine: "Pazar, 29 Mart 2026",
      time: "01:59",
    });
    expect(formatAppointmentDisplay("2026-03-29T01:00:00.000Z", "Europe/Berlin").time).toBe("03:00");
  });

  it("the weekday comes from the salon-local calendar date, not the server's", () => {
    // 2026-11-01T23:30Z is Sunday night UTC but already Monday in Istanbul.
    expect(formatAppointmentDisplay("2026-11-01T23:30:00.000Z", "Europe/Istanbul").dateLine).toBe("Pazartesi, 2 Kasım 2026");
  });
});

describe("C13. multiple services", () => {
  it("lists every service, with the plural label, in order", () => {
    const { html, text } = buildAppointmentConfirmationEmail(
      baseInput({ serviceNames: ["Saç Kesimi", "Fön", "Sakal Tıraşı"] }),
    );
    expect(html).toContain("HİZMETLER");
    expect(html.indexOf("Saç Kesimi")).toBeLessThan(html.indexOf("Fön"));
    expect(html.indexOf("Fön")).toBeLessThan(html.indexOf("Sakal Tıraşı"));
    expect(text).toContain("Hizmetler:\n- Saç Kesimi\n- Fön\n- Sakal Tıraşı");
  });

  it("a single service uses the singular label and one line", () => {
    const { html, text } = buildAppointmentConfirmationEmail(baseInput());
    expect(html).toContain("HİZMET<");
    expect(html).not.toContain("HİZMETLER");
    expect(text).toContain("Hizmet: Saç Kesimi");
  });

  it("is bounded: an absurd number of services cannot balloon the email", () => {
    const many = Array.from({ length: 40 }, (_v, i) => `Hizmet ${i + 1}`);
    const { text } = buildAppointmentConfirmationEmail(baseInput({ serviceNames: many }));
    expect(text.match(/^- Hizmet /gm)?.length).toBe(8);
  });
});

describe("C14. HTML escaping of every database-controlled value", () => {
  const hostile = {
    salonName: `<script>alert(1)</script> & "Q" 'S'`,
    greetingName: `<b>Ali</b>`,
    serviceNames: [`<img src=x onerror=alert(1)>`, `Saç & "Boya"`],
  };

  it("no raw markup from a stored value survives in the HTML", () => {
    const { html } = buildAppointmentConfirmationEmail(baseInput(hostile));
    expect(html).not.toContain("<script>alert(1)");
    expect(html).not.toContain("<b>Ali</b>");
    expect(html).not.toContain("<img");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt; &amp; &quot;Q&quot; &#39;S&#39;");
    expect(html).toContain("&lt;b&gt;Ali&lt;/b&gt;");
    expect(html).toContain("&lt;img src=x onerror=alert(1)&gt;");
    expect(html).toContain("Saç &amp; &quot;Boya&quot;");
  });

  it("a location link is escaped as an attribute value and cannot break out of it", () => {
    const { html } = buildAppointmentConfirmationEmail(
      baseInput({ locationUrl: `https://maps.example.org/place?q=a&b='c'` }),
    );
    // the URL parser percent-encodes the apostrophes; the ampersand is HTML-escaped for the attribute
    expect(html).toContain(`href="https://maps.example.org/place?q=a&amp;b=%27c%27"`);
    const hrefs = [...html.matchAll(/href="([^"]*)"/g)].map((m) => m[1]);
    expect(hrefs).toHaveLength(1);
  });

  it("the stored (unescaped) text reaches the plain-text alternative as-is, and no HTML entity does", () => {
    const { text } = buildAppointmentConfirmationEmail(baseInput({ salonName: "Ali & Veli", serviceNames: ["Saç & Boya"] }));
    expect(text).toContain("Ali & Veli");
    expect(text).toContain("Hizmet: Saç & Boya");
    expect(text).not.toContain("&amp;");
  });
});

describe("C15. plain-text alternative", () => {
  it("carries the whole message with no markup", () => {
    const { text } = buildAppointmentConfirmationEmail(baseInput());
    expect(text).toBe(
      [
        "Gökhan İlhan Hair Studio",
        "",
        "Ayşe, randevunuz onaylandı ✓",
        "",
        "Sizi Gökhan İlhan Hair Studio'da ağırlamak için sabırsızlanıyoruz.",
        "",
        "Tarih: Çarşamba, 7 Ekim 2026",
        "Saat: 14:30",
        "Hizmet: Saç Kesimi",
        "",
        `Yol tarifi: ${SAMPLE_LOCATION}`,
        "",
        "Bu ileti randevu onayınız için otomatik olarak gönderilmiştir; lütfen yanıtlamayınız.",
        "Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.",
      ].join("\n"),
    );
    expect(text).not.toMatch(/<[a-z!/]/i);
  });
});

describe("C16-C18. what the email must NOT contain", () => {
  const withExtras = {
    ...baseInput({ serviceNames: ["Saç Kesimi", "Fön"] }),
    // Fields a careless caller might pass; the template has no input for them.
    notes: "Müşteri alerjik: SECRET-NOTE-TEXT",
    price: 950,
    staffName: "Mehmet Usta",
    staffPhone: "+905550000000",
    appointmentId: "9d2f6a1e-4b7c-4d0e-8a55-1c2b3d4e5f60",
    tenantId: "0e7a2c9b-6d1f-4a34-9b8c-7e6d5c4b3a21",
    role: "Yönetici",
  } as unknown as AppointmentConfirmationTemplateInput;

  it("C16. no appointment notes", () => {
    const { html, text } = buildAppointmentConfirmationEmail(withExtras);
    expect(html).not.toContain("SECRET-NOTE-TEXT");
    expect(text).not.toContain("SECRET-NOTE-TEXT");
  });

  it("C17. no prices", () => {
    const { html, text, subject } = buildAppointmentConfirmationEmail(withExtras);
    for (const content of [html, text, subject]) {
      expect(content).not.toContain("950");
      expect(content).not.toMatch(/₺|\bTL\b|\bTRY\b/);
    }
  });

  it("C18. no internal ids, staff or role details, no tracking, no remote resources", () => {
    const { html, text } = buildAppointmentConfirmationEmail(withExtras);
    for (const content of [html, text]) {
      expect(content).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i);
      expect(content).not.toContain("Mehmet Usta");
      expect(content).not.toContain("+905550000000");
      expect(content).not.toContain("Yönetici");
      expect(content).not.toMatch(/lockToken|lock_token|\btoken\b/i);
    }
    // no tracking pixel, no images at all, no remote stylesheet/font/script
    expect(html).not.toMatch(/<img|<script|<link|<iframe|@import|url\(|background=/i);
    // the only outbound reference is the location link
    const urls = [...html.matchAll(/https?:\/\/[^\s"'<>)]+/g)].map((m) => m[0]);
    expect(urls).toEqual([SAMPLE_LOCATION]);
    // no marketing call to action
    expect(html).not.toMatch(/indirim|kampanya|kupon|abone|unsubscribe|follow|instagram/i);
  });
});

describe("the location button", () => {
  it("renders 'Yol Tarifi Al' pointing at the salon's link when it is valid", () => {
    const { html, text } = buildAppointmentConfirmationEmail(baseInput());
    expect(html).toContain(`href="${SAMPLE_LOCATION}"`);
    expect(html).toContain(">Yol Tarifi Al</a>");
    expect(text).toContain(`Yol tarifi: ${SAMPLE_LOCATION}`);
  });

  it("is omitted (the email still renders) when the branch has no link", () => {
    for (const locationUrl of [null, "", "   "]) {
      const { html, text } = buildAppointmentConfirmationEmail(baseInput({ locationUrl }));
      expect(html).not.toContain("Yol Tarifi Al");
      expect(text).not.toContain("Yol tarifi");
      expect(html).toContain("randevunuz <span");
    }
  });

  it("is omitted for every link that fails the https-only rule", () => {
    for (const locationUrl of [
      "javascript:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "file:///etc/passwd",
      "http://share.google/SampleSalonLink0001",
      "https://good.example@evil.example/",
    ]) {
      const { html } = buildAppointmentConfirmationEmail(baseInput({ locationUrl }));
      expect(html).not.toContain("Yol Tarifi Al");
      expect(html).not.toContain("javascript:");
      expect(html).not.toContain("evil.example");
    }
  });
});

describe("sanitizeEmailLocationUrl", () => {
  it("accepts the pilot share link and other public https map links, returning the canonical href", () => {
    expect(sanitizeEmailLocationUrl(SAMPLE_LOCATION)).toBe(SAMPLE_LOCATION);
    expect(sanitizeEmailLocationUrl("  https://maps.app.goo.gl/AbCdEf123  ")).toBe("https://maps.app.goo.gl/AbCdEf123");
    expect(sanitizeEmailLocationUrl("https://www.google.com/maps/place/Salon/@41.0,29.0,17z")).toBe(
      "https://www.google.com/maps/place/Salon/@41.0,29.0,17z",
    );
    expect(sanitizeEmailLocationUrl("https://SHARE.GOOGLE:443/x")).toBe("https://share.google/x");
  });

  it("rejects every non-https scheme", () => {
    for (const value of [
      "javascript:alert(1)",
      "JAVASCRIPT:alert(1)",
      "data:text/html;base64,PHNjcmlwdD4=",
      "file:///C:/Windows/win.ini",
      "http://share.google/x",
      "ftp://share.google/x",
      "blob:https://share.google/uuid",
      "mailto:a@example.test",
      "//share.google/x",
      "share.google/x",
    ]) {
      expect(sanitizeEmailLocationUrl(value), value).toBeNull();
    }
  });

  it("rejects credentials, odd ports, IP literals and internal names", () => {
    for (const value of [
      "https://user:pass@share.google/x",
      "https://share.google@evil.example/x",
      "https://share.google:8443/x",
      "https://127.0.0.1/x",
      "https://192.168.1.10/x",
      "https://[::1]/x",
      "https://localhost/x",
      "https://printer.local/x",
      "https://intranet/x",
      "https://8.8.8.8/x",
    ]) {
      expect(sanitizeEmailLocationUrl(value), value).toBeNull();
    }
  });

  it("rejects internationalised (punycode) hosts, whitespace/control characters and oversized values", () => {
    expect(sanitizeEmailLocationUrl("https://xn--gkhan-ixa.example/x")).toBeNull();
    expect(sanitizeEmailLocationUrl("https://gökhan.example/x")).toBeNull();
    expect(sanitizeEmailLocationUrl("https://share.google/a b")).toBeNull();
    expect(sanitizeEmailLocationUrl("https://share.google/a\nb")).toBeNull();
    expect(sanitizeEmailLocationUrl("https://share.google/a\u0000b")).toBeNull();
    expect(sanitizeEmailLocationUrl("https://share.google/a\u2028b")).toBeNull();
    expect(sanitizeEmailLocationUrl(`https://share.google/${"a".repeat(2100)}`)).toBeNull();
  });

  it("rejects non-strings", () => {
    expect(sanitizeEmailLocationUrl(null)).toBeNull();
    expect(sanitizeEmailLocationUrl(undefined)).toBeNull();
    expect(sanitizeEmailLocationUrl(42 as unknown as string)).toBeNull();
  });
});

describe("greeting name", () => {
  // Faz NOTIF.1B, test 1: named headline.
  it("a greetingName produces a headline of '{name}, randevunuz onaylandı'", () => {
    const { html, text } = buildAppointmentConfirmationEmail(baseInput({ greetingName: "Ayşe" }));
    expect(html).toContain("Ayşe, randevunuz");
    expect(text).toContain("Ayşe, randevunuz onaylandı ✓");
  });

  // Faz NOTIF.1B, test 2: no separate salutation line duplicating the name.
  it("does not also render a separate 'Merhaba Ayşe,' line", () => {
    const { html, text } = buildAppointmentConfirmationEmail(baseInput({ greetingName: "Ayşe" }));
    expect(html).not.toContain("Merhaba Ayşe,");
    expect(html).not.toContain("Merhaba,");
    expect(text).not.toContain("Merhaba");
  });

  // Faz NOTIF.1B, test 3: generic fallback headline.
  it("null/blank greetingName falls back to the generic 'Randevunuz onaylandı' headline", () => {
    for (const greetingName of [null, "", "   "]) {
      const { html, text } = buildAppointmentConfirmationEmail(baseInput({ greetingName }));
      expect(html).toMatch(/>Randevunuz <span[^>]*>onaylandı/);
      expect(text).toContain("\nRandevunuz onaylandı ✓\n");
    }
  });

  // Faz NOTIF.1B, test 4: a hostile name cannot break out of the headline markup.
  it("a hostile greetingName remains HTML-escaped inside the headline", () => {
    const { html } = buildAppointmentConfirmationEmail(baseInput({ greetingName: `<b>Ali</b>` }));
    expect(html).not.toContain("<b>Ali</b>");
    expect(html).toContain("&lt;b&gt;Ali&lt;/b&gt;, randevunuz");
  });

  it("greets by the first name as typed in the headline", () => {
    expect(buildAppointmentConfirmationEmail(baseInput({ greetingName: "Zeynep" })).html).toContain("Zeynep, randevunuz");
  });

  it("only a name typed entirely in capitals is normalised (Turkish casing rules); anything else is left alone", () => {
    expect(formatGreetingName("AYŞE")).toBe("Ayşe");
    expect(formatGreetingName("İBRAHİM")).toBe("İbrahim");
    expect(formatGreetingName("IŞIK")).toBe("Işık");
    expect(formatGreetingName("ALİ-CAN")).toBe("Ali-Can");
    expect(formatGreetingName("Ayşe")).toBe("Ayşe");
    expect(formatGreetingName("McAllister")).toBe("McAllister");
    expect(formatGreetingName("ali")).toBe("ali");
    expect(formatGreetingName("A")).toBe("A");
  });

  it("strips control characters and bounds the length", () => {
    expect(formatGreetingName("Ay\r\nşe")).toBe("Ay şe");
    expect(Array.from(formatGreetingName("x".repeat(200))!).length).toBeLessThanOrEqual(60);
    expect(formatGreetingName(undefined)).toBeNull();
  });
});

describe("structure", () => {
  it("is a mobile-friendly, self-contained document", () => {
    const { html } = buildAppointmentConfirmationEmail(baseInput());
    expect(html).toContain('<html lang="tr">');
    expect(html).toContain('<meta name="viewport" content="width=device-width, initial-scale=1">');
    expect(html).toContain("<title>Randevunuz Onaylandı — Gökhan İlhan Hair Studio</title>");
    expect(html).toContain("max-width:560px");
    expect(html).toContain('role="presentation"');
    // preview text
    expect(html).toContain("Randevunuz onaylandı · Çarşamba, 7 Ekim 2026, 14:30");
  });

  it("is deterministic and does not mutate its input", () => {
    const input = baseInput({ serviceNames: ["A", "B"] });
    const snapshot = JSON.parse(JSON.stringify(input));
    const first = buildAppointmentConfirmationEmail(input);
    const second = buildAppointmentConfirmationEmail(input);
    expect(second).toEqual(first);
    expect(JSON.parse(JSON.stringify(input))).toEqual(snapshot);
  });

  it("truncates an absurdly long salon name instead of breaking the layout", () => {
    const { subject } = buildAppointmentConfirmationEmail(baseInput({ salonName: "S".repeat(500) }));
    expect(Array.from(subject).length).toBeLessThan(130);
    expect(subject.endsWith("…")).toBe(true);
  });
});
