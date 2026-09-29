import { utcIsoToTenantLocalParts } from "@/lib/modules/appointments/timezone";
import { sanitizeEmailLocationUrl } from "@/lib/email/location-url";

/**
 * Faz NOTIF.1A/1B — the customer appointment-confirmation email, in
 * Turkish. Pure by design, like the invitation template: no Supabase
 * import, no env reads, no DB access, no logging. Everything it renders
 * is passed in by the worker (lib/modules/customer-notifications/
 * confirmation-email-worker.ts); this module only turns that data into
 * {subject, html, text}.
 *
 * What the email carries — and, on purpose, nothing else: the salon's
 * name, a headline of "{first name}, randevunuz onaylandı ✓" (or plain
 * "Randevunuz onaylandı ✓" with no name) that doubles as the greeting —
 * there is no separate "Merhaba X," line repeating the name again below
 * it — the appointment date and time in the SALON'S OWN timezone, the
 * service name(s), and — only when the branch has a valid https location
 * link — a "Yol Tarifi Al" button. No notes, no prices, no staff names or
 * contact details, no internal ids, no roles, no marketing call to
 * action, no tracking pixel, no remote image, no remote font. The
 * customer's name never appears in the subject or preheader (both can
 * surface in a lock-screen/notification preview) — only in the headline,
 * inside the opened email.
 *
 * Every database-controlled value is HTML-escaped where it is placed in
 * the markup, and the subject is stripped of control characters (a value
 * containing a line break must never be able to reach a header).
 *
 * Layout: single 560 px column of table markup with inline styles (the
 * only thing mail clients render dependably), fluid down to phone width,
 * system font stack (no web font), light theme with explicit colors on
 * every element so a client's forced dark mode cannot leave dark text on
 * a dark ground.
 */
export type AppointmentConfirmationTemplateInput = {
  salonName: string;
  /** First name typed for this booking, or null. */
  greetingName: string | null;
  /** The appointment start as a UTC ISO instant. */
  appointmentStartAt: string;
  tenantTimezone: string;
  serviceNames: string[];
  /** branches.location_url as stored; validated (https-only) here. */
  locationUrl: string | null;
};

export type AppointmentConfirmationEmailContent = {
  subject: string;
  html: string;
  text: string;
};

const TR_MONTH_NAMES = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
] as const;

// Index = Date#getUTCDay() (0 = Sunday).
const TR_WEEKDAY_NAMES = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"] as const;

const MAX_SERVICE_LINES = 8;
const MAX_TEXT_FIELD_LENGTH = 120;

/** Strips C0/C1 control characters, then collapses whitespace (the regex
 * whitespace class also folds U+2028 and U+2029): a single-line,
 * header-safe string. */
function singleLine(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "AYŞE" -> "Ayşe", "ali-can" untouched, "Ayşe" untouched. Only a name
 * typed entirely in capitals is normalized — anything the customer cased
 * themselves is left as they wrote it. Turkish casing rules (İ/ı). */
export function formatGreetingName(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const name = truncate(singleLine(raw), 60);
  if (name.length === 0) return null;

  const letters = Array.from(name).filter((ch) => ch.toLocaleLowerCase("tr-TR") !== ch.toLocaleUpperCase("tr-TR"));
  const allCaps = letters.length > 1 && name === name.toLocaleUpperCase("tr-TR");
  if (!allCaps) return name;

  return name
    .split("-")
    .map((part) => {
      const chars = Array.from(part.toLocaleLowerCase("tr-TR"));
      const [first, ...rest] = chars;
      return first === undefined ? "" : `${first.toLocaleUpperCase("tr-TR")}${rest.join("")}`;
    })
    .join("-");
}

export type AppointmentDisplayParts = {
  /** "Salı, 7 Ekim 2026" */
  dateLine: string;
  /** "14:30" */
  time: string;
};

/** Tenant-local, DST-correct (Intl via utcIsoToTenantLocalParts), and
 * deterministic across ICU builds: month and weekday names come from the
 * tables above, the weekday from the tenant-LOCAL calendar date (never
 * from the server's own timezone). */
export function formatAppointmentDisplay(isoInstant: string, tenantTimezone: string): AppointmentDisplayParts {
  const { date, time } = utcIsoToTenantLocalParts(isoInstant, tenantTimezone);
  const [yearStr, monthStr, dayStr] = date.split("-");
  const year = Number(yearStr);
  const month = Number(monthStr);
  const day = Number(dayStr);
  if (!Number.isFinite(year) || !Number.isFinite(month) || !Number.isFinite(day) || month < 1 || month > 12) {
    throw new RangeError("invalid appointment date");
  }
  const weekday = TR_WEEKDAY_NAMES[new Date(Date.UTC(year, month - 1, day)).getUTCDay()]!;
  return { dateLine: `${weekday}, ${day} ${TR_MONTH_NAMES[month - 1]} ${year}`, time };
}

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const INK = "#111827";
const MUTED = "#5B6573";
const HAIRLINE = "#E3E7EC";
const PAGE_BG = "#EEF1F4";
const PANEL_BG = "#F5F7FA";
const SUCCESS = "#0B7A55";

export function buildAppointmentConfirmationEmail(
  input: AppointmentConfirmationTemplateInput,
): AppointmentConfirmationEmailContent {
  const salonName = truncate(singleLine(input.salonName), 100) || "Salon";
  const greetingName = formatGreetingName(input.greetingName);
  const { dateLine, time } = formatAppointmentDisplay(input.appointmentStartAt, input.tenantTimezone);
  const locationUrl = sanitizeEmailLocationUrl(input.locationUrl);

  const services = input.serviceNames
    .map((name) => truncate(singleLine(name), MAX_TEXT_FIELD_LENGTH))
    .filter((name) => name.length > 0)
    .slice(0, MAX_SERVICE_LINES);
  const serviceLabelHtml = services.length > 1 ? "HİZMETLER" : "HİZMET";
  const serviceLabelText = services.length > 1 ? "Hizmetler" : "Hizmet";

  const subject = `Randevunuz Onaylandı — ${salonName}`;
  // Faz NOTIF.1B — the headline itself is the greeting now: named when a
  // greetingName exists, generic otherwise. No separate "Merhaba X," line
  // follows it (that would just repeat the same name twice in a row).
  const headlineLead = greetingName ? `${greetingName}, randevunuz` : "Randevunuz";
  // Faz NOTIF.1B fix — no Turkish locative suffix ("'da"/"'de"/"'ta"/
  // "'te") on the tenant name: which one is grammatical depends on the
  // name's own vowel harmony and voicing, which this function has no way
  // to know for an arbitrary salon name (compare "Gökhan İlhan Hair
  // Studio'da" against "Doğuş Güzellik'te" against "Lush Long Beach'te").
  // Rephrased so the salon name never takes a suffix at all — the second
  // sentence needs no name and so no suffix, on purpose.
  const introLine1 = `Randevunuz ${salonName} tarafından onaylandı.`;
  const introLine2 = "Sizi ağırlamak için sabırsızlanıyoruz.";
  const preheader = `Randevunuz onaylandı · ${dateLine}, ${time}`;

  const salonHtml = escapeHtml(salonName);
  const headlineLeadHtml = escapeHtml(headlineLead);
  const introLine1Html = escapeHtml(introLine1);
  const introLine2Html = escapeHtml(introLine2);
  const dateLineHtml = escapeHtml(dateLine);
  const timeHtml = escapeHtml(time);
  const preheaderHtml = escapeHtml(preheader);
  const servicesHtml = services
    .map((name) => `<div style="padding:2px 0;">${escapeHtml(name)}</div>`)
    .join("");

  const buttonHtml = locationUrl
    ? `<tr>
            <td align="center" style="padding:28px 0 4px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                <tr>
                  <td align="center" bgcolor="${INK}" style="background-color:${INK};border-radius:10px;mso-padding-alt:14px 32px;">
                    <a href="${escapeHtml(locationUrl)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-family:${FONT_STACK};font-size:16px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:10px;">Yol Tarifi Al</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : "";

  const servicesRowHtml =
    services.length > 0
      ? `<tr>
                  <td style="padding:0 20px;"><div style="height:1px;line-height:1px;font-size:1px;background-color:${HAIRLINE};">&nbsp;</div></td>
                </tr>
                <tr>
                  <td style="padding:16px 20px 4px 20px;font-family:${FONT_STACK};font-size:12px;font-weight:600;letter-spacing:0.08em;color:${MUTED};">${serviceLabelHtml}</td>
                </tr>
                <tr>
                  <td style="padding:0 20px 20px 20px;font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${INK};">${servicesHtml}</td>
                </tr>`
      : "";

  const html = `<!DOCTYPE html>
<html lang="tr">
  <head>
    <meta charset="utf-8">
    <meta name="viewport" content="width=device-width, initial-scale=1">
    <meta name="x-apple-disable-message-reformatting">
    <meta name="color-scheme" content="light">
    <meta name="supported-color-schemes" content="light">
    <title>${escapeHtml(subject)}</title>
  </head>
  <body style="margin:0;padding:0;background-color:${PAGE_BG};">
    <div style="display:none;max-height:0;overflow:hidden;opacity:0;color:${PAGE_BG};font-size:1px;line-height:1px;mso-hide:all;">${preheaderHtml}</div>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background-color:${PAGE_BG};">
      <tr>
        <td align="center" style="padding:32px 16px;">
          <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="width:100%;max-width:560px;">
            <tr>
              <td style="padding:0 4px 14px 4px;font-family:${FONT_STACK};font-size:14px;font-weight:600;line-height:20px;color:${MUTED};">${salonHtml}</td>
            </tr>
            <tr>
              <td style="background-color:#FFFFFF;border:1px solid ${HAIRLINE};border-radius:16px;padding:32px 28px;">
                <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0">
                  <tr>
                    <td style="font-family:${FONT_STACK};font-size:24px;font-weight:700;line-height:30px;color:${INK};padding-bottom:20px;">${headlineLeadHtml} <span style="white-space:nowrap;">onaylandı <span style="color:${SUCCESS};">&#10003;</span></span></td>
                  </tr>
                  <tr>
                    <td style="font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${MUTED};padding-bottom:24px;">${introLine1Html}<br>${introLine2Html}</td>
                  </tr>
                  <tr>
                    <td>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PANEL_BG}" style="background-color:${PANEL_BG};border-radius:12px;">
                        <tr>
                          <td style="padding:20px 20px 4px 20px;font-family:${FONT_STACK};font-size:12px;font-weight:600;letter-spacing:0.08em;color:${MUTED};">TARİH VE SAAT</td>
                        </tr>
                        <tr>
                          <td style="padding:0 20px 20px 20px;font-family:${FONT_STACK};color:${INK};">
                            <div style="font-size:16px;font-weight:600;line-height:24px;">${dateLineHtml}</div>
                            <div style="font-size:30px;font-weight:700;line-height:38px;letter-spacing:-0.01em;">${timeHtml}</div>
                          </td>
                        </tr>
                        ${servicesRowHtml}
                      </table>
                    </td>
                  </tr>
                  ${buttonHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 8px 0 8px;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${MUTED};text-align:center;">
                Bu ileti randevu onayınız için otomatik olarak gönderilmiştir; lütfen yanıtlamayınız. Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;

  const textLines = [
    salonName,
    "",
    `${headlineLead} onaylandı ✓`,
    "",
    introLine1,
    introLine2,
    "",
    `Tarih: ${dateLine}`,
    `Saat: ${time}`,
  ];
  if (services.length === 1) {
    textLines.push(`${serviceLabelText}: ${services[0]}`);
  } else if (services.length > 1) {
    textLines.push(`${serviceLabelText}:`, ...services.map((name) => `- ${name}`));
  }
  if (locationUrl) {
    textLines.push("", `Yol tarifi: ${locationUrl}`);
  }
  textLines.push(
    "",
    "Bu ileti randevu onayınız için otomatik olarak gönderilmiştir; lütfen yanıtlamayınız.",
    "Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.",
  );

  return { subject, html, text: textLines.join("\n") };
}
