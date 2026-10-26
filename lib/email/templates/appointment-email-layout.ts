import { utcIsoToTenantLocalParts } from "@/lib/modules/appointments/timezone";

/**
 * Faz LAUNCH.1B — the shared, pure layout for every customer appointment email
 * (confirmation, change, cancellation, reminder). Extracted from the NOTIF.1A/1B
 * confirmation template so the four emails look like one product; the confirmation
 * output is byte-identical to before for the same inputs (golden-tested).
 *
 * Pure by design: no Supabase import, no env reads, no database access, no logging.
 * What an email may carry is decided by the callers; this module only renders it:
 * salon name, a headline, the appointment date and time in the SALON'S timezone,
 * service names, optionally staff names and a contact phone, and optionally one
 * button. Never notes, prices, internal ids, roles, tracking pixels, remote
 * images or remote fonts. Every database-controlled value is HTML-escaped where it
 * is placed, and the subject is stripped of control characters.
 */

export const TR_MONTH_NAMES = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
] as const;

// Index = Date#getUTCDay() (0 = Sunday).
export const TR_WEEKDAY_NAMES = ["Pazar", "Pazartesi", "Salı", "Çarşamba", "Perşembe", "Cuma", "Cumartesi"] as const;

export const MAX_SERVICE_LINES = 8;
export const MAX_STAFF_LINES = 4;
export const MAX_TEXT_FIELD_LENGTH = 120;

/** Strips C0/C1 control characters, then collapses whitespace (the regex whitespace
 * class also folds U+2028 and U+2029): a single-line, header-safe string. */
export function singleLine(value: string): string {
  return value
    .replace(/[\x00-\x1f\x7f-\x9f]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

export function truncate(value: string, max: number): string {
  const chars = Array.from(value);
  return chars.length <= max ? value : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

export function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/** "AYŞE" -> "Ayşe", "ali-can" untouched, "Ayşe" untouched. Only a name typed
 * entirely in capitals is normalized. Turkish casing rules (İ/ı). */
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

/** Tenant-local, DST-correct (Intl via utcIsoToTenantLocalParts), and deterministic
 * across ICU builds: month and weekday names come from the tables above, the weekday
 * from the tenant-LOCAL calendar date (never from the server's own timezone). */
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

/** How many tenant-LOCAL calendar days the appointment is after `referenceInstant`
 * (0 = same local day, 1 = the next local day, ...). Server timezone never enters. */
export function localDayDifference(referenceInstant: string, appointmentInstant: string, tenantTimezone: string): number {
  const ref = utcIsoToTenantLocalParts(referenceInstant, tenantTimezone).date.split("-").map(Number);
  const apt = utcIsoToTenantLocalParts(appointmentInstant, tenantTimezone).date.split("-").map(Number);
  const refDay = Date.UTC(ref[0]!, ref[1]! - 1, ref[2]!);
  const aptDay = Date.UTC(apt[0]!, apt[1]! - 1, apt[2]!);
  return Math.round((aptDay - refDay) / 86_400_000);
}

/** A phone number as a customer would dial it: digits, spaces and + - ( ). Anything else
 * (letters, markup, control characters) is dropped as a whole. */
export function sanitizeContactPhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const value = singleLine(raw);
  if (value.length < 5 || value.length > 30) return null;
  return /^[+0-9][0-9 ()\-+]*$/.test(value) ? value : null;
}

const FONT_STACK =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, 'Helvetica Neue', Arial, sans-serif";

const INK = "#111827";
const MUTED = "#5B6573";
const HAIRLINE = "#E3E7EC";
const PAGE_BG = "#EEF1F4";
const PANEL_BG = "#F5F7FA";
const SUCCESS = "#0B7A55";

export type AppointmentEmailLayout = {
  subject: string;
  /** Already cleaned (single line, truncated). */
  salonName: string;
  preheader: string;
  headlineLead: string;
  /** The part of the headline kept on one line (e.g. "onaylandı"). */
  headlineTail: string;
  headlineMark: "check" | null;
  intro: string[];
  /** Panel label above the date, e.g. "TARİH VE SAAT". */
  dateLabel: string;
  dateLine: string;
  time: string;
  services: string[];
  staffNames: string[];
  contactPhone: string | null;
  /** RC.1A: one concise, already-cleaned salon-authored preparation line (confirmation and reminder only), or null. */
  preparationNote?: string | null;
  button: { label: string; url: string; textLabel: string } | null;
  footer: string;
  /** Footer split into plain-text lines. */
  textFooter: string[];
};

export type AppointmentEmailContent = {
  subject: string;
  html: string;
  text: string;
};

function panelSectionHtml(label: string, valuesHtml: string, withDivider: boolean): string {
  const divider = withDivider
    ? `<tr>
                  <td style="padding:0 20px;"><div style="height:1px;line-height:1px;font-size:1px;background-color:${HAIRLINE};">&nbsp;</div></td>
                </tr>
                `
    : "";
  return `${divider}<tr>
                  <td style="padding:16px 20px 4px 20px;font-family:${FONT_STACK};font-size:12px;font-weight:600;letter-spacing:0.08em;color:${MUTED};">${label}</td>
                </tr>
                <tr>
                  <td style="padding:0 20px 20px 20px;font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${INK};">${valuesHtml}</td>
                </tr>`;
}

export function renderAppointmentEmail(layout: AppointmentEmailLayout): AppointmentEmailContent {
  const {
    subject, salonName, preheader, headlineLead, headlineTail, headlineMark, intro,
    dateLabel, dateLine, time, services, staffNames, contactPhone, button, footer, textFooter,
  } = layout;
  const preparationNote = layout.preparationNote ?? null;

  const salonHtml = escapeHtml(salonName);
  const headlineLeadHtml = escapeHtml(headlineLead);
  const headlineTailHtml = escapeHtml(headlineTail);
  const introHtml = intro.map((line) => escapeHtml(line)).join("<br>");
  const dateLineHtml = escapeHtml(dateLine);
  const timeHtml = escapeHtml(time);
  const preheaderHtml = escapeHtml(preheader);
  const dateLabelHtml = escapeHtml(dateLabel);
  const footerHtml = escapeHtml(footer);

  const serviceLabelHtml = services.length > 1 ? "HİZMETLER" : "HİZMET";
  const serviceLabelText = services.length > 1 ? "Hizmetler" : "Hizmet";
  const servicesHtml = services.map((name) => `<div style="padding:2px 0;">${escapeHtml(name)}</div>`).join("");
  const staffLabelHtml = staffNames.length > 1 ? "PERSONEL" : "PERSONEL";
  const staffHtml = staffNames.map((name) => `<div style="padding:2px 0;">${escapeHtml(name)}</div>`).join("");

  const buttonHtml = button
    ? `<tr>
            <td align="center" style="padding:28px 0 4px 0;">
              <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:0 auto;">
                <tr>
                  <td align="center" bgcolor="${INK}" style="background-color:${INK};border-radius:10px;mso-padding-alt:14px 32px;">
                    <a href="${escapeHtml(button.url)}" target="_blank" rel="noopener" style="display:inline-block;padding:14px 32px;font-family:${FONT_STACK};font-size:16px;font-weight:600;line-height:20px;color:#FFFFFF;text-decoration:none;border-radius:10px;">${escapeHtml(button.label)}</a>
                  </td>
                </tr>
              </table>
            </td>
          </tr>`
    : "";

  const extraSections = [
    services.length > 0 ? panelSectionHtml(serviceLabelHtml, servicesHtml, true) : "",
    staffNames.length > 0 ? panelSectionHtml(staffLabelHtml, staffHtml, true) : "",
    preparationNote ? panelSectionHtml("RANDEVU ÖNCESİ", escapeHtml(preparationNote), true) : "",
    contactPhone ? panelSectionHtml("İLETİŞİM", escapeHtml(contactPhone), true) : "",
  ].join("");

  const markHtml = headlineMark === "check" ? ` <span style="color:${SUCCESS};">&#10003;</span>` : "";

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
                    <td style="font-family:${FONT_STACK};font-size:24px;font-weight:700;line-height:30px;color:${INK};padding-bottom:20px;">${headlineLeadHtml} <span style="white-space:nowrap;">${headlineTailHtml}${markHtml}</span></td>
                  </tr>
                  <tr>
                    <td style="font-family:${FONT_STACK};font-size:16px;line-height:24px;color:${MUTED};padding-bottom:24px;">${introHtml}</td>
                  </tr>
                  <tr>
                    <td>
                      <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" bgcolor="${PANEL_BG}" style="background-color:${PANEL_BG};border-radius:12px;">
                        <tr>
                          <td style="padding:20px 20px 4px 20px;font-family:${FONT_STACK};font-size:12px;font-weight:600;letter-spacing:0.08em;color:${MUTED};">${dateLabelHtml}</td>
                        </tr>
                        <tr>
                          <td style="padding:0 20px 20px 20px;font-family:${FONT_STACK};color:${INK};">
                            <div style="font-size:16px;font-weight:600;line-height:24px;">${dateLineHtml}</div>
                            <div style="font-size:30px;font-weight:700;line-height:38px;letter-spacing:-0.01em;">${timeHtml}</div>
                          </td>
                        </tr>
                        ${extraSections}
                      </table>
                    </td>
                  </tr>
                  ${buttonHtml}
                </table>
              </td>
            </tr>
            <tr>
              <td style="padding:20px 8px 0 8px;font-family:${FONT_STACK};font-size:13px;line-height:20px;color:${MUTED};text-align:center;">
                ${footerHtml}
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
    `${headlineLead} ${headlineTail}${headlineMark === "check" ? " ✓" : ""}`,
    "",
    ...intro,
    "",
    `Tarih: ${dateLine}`,
    `Saat: ${time}`,
  ];
  if (services.length === 1) {
    textLines.push(`${serviceLabelText}: ${services[0]}`);
  } else if (services.length > 1) {
    textLines.push(`${serviceLabelText}:`, ...services.map((name) => `- ${name}`));
  }
  if (staffNames.length === 1) {
    textLines.push(`Personel: ${staffNames[0]}`);
  } else if (staffNames.length > 1) {
    textLines.push("Personel:", ...staffNames.map((name) => `- ${name}`));
  }
  if (preparationNote) {
    textLines.push(`Randevu öncesi: ${preparationNote}`);
  }
  if (contactPhone) {
    textLines.push(`İletişim: ${contactPhone}`);
  }
  if (button) {
    textLines.push("", `${button.textLabel}: ${button.url}`);
  }
  textLines.push("", ...textFooter);

  return { subject, html, text: textLines.join("\n") };
}

/** The customer-visible inputs every lifecycle email is built from. */
export type AppointmentEmailInput = {
  salonName: string;
  /** First name typed for this booking, or null. */
  greetingName: string | null;
  /** The appointment start as a UTC ISO instant. */
  appointmentStartAt: string;
  tenantTimezone: string;
  serviceNames: string[];
  /** Staff display names booked on the appointment (may be empty). */
  staffNames?: string[];
  /** The branch's phone number (may be null). */
  contactPhone?: string | null;
  /** branches.location_url as stored; validated (https-only) by the caller's template. */
  locationUrl: string | null;
  /** RC.1A: the services' salon-authored preparation note(s) from the claim payload; used by the confirmation and the reminder only. */
  preparationNote?: string | null;
};

/** One concise line: single line, control characters gone, at most 240 characters; null when nothing is left. */
export function cleanPreparationNote(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const line = truncate(singleLine(raw), 240);
  return line.length > 0 ? line : null;
}

export function cleanSalonName(raw: string): string {
  return truncate(singleLine(raw), 100) || "Salon";
}

export function cleanServiceNames(raw: string[]): string[] {
  return raw
    .map((name) => truncate(singleLine(name), MAX_TEXT_FIELD_LENGTH))
    .filter((name) => name.length > 0)
    .slice(0, MAX_SERVICE_LINES);
}

export function cleanStaffNames(raw: string[] | undefined): string[] {
  return (raw ?? [])
    .map((name) => truncate(singleLine(name), 60))
    .filter((name) => name.length > 0)
    .slice(0, MAX_STAFF_LINES);
}
