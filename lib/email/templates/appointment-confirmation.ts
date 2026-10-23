import { sanitizeEmailLocationUrl } from "@/lib/email/location-url";
import {
  cleanSalonName,
  cleanServiceNames,
  cleanStaffNames,
  formatAppointmentDisplay,
  formatGreetingName,
  renderAppointmentEmail,
  sanitizeContactPhone,
  type AppointmentDisplayParts,
  type AppointmentEmailContent,
  type AppointmentEmailInput,
} from "@/lib/email/templates/appointment-email-layout";

/**
 * Faz NOTIF.1A/1B — the customer appointment-confirmation email, in Turkish. Pure
 * by design, like the invitation template: no Supabase import, no env reads, no DB
 * access, no logging. Everything it renders is passed in by the worker
 * (lib/modules/customer-notifications/confirmation-email-worker.ts).
 *
 * Faz LAUNCH.1B — the rendering moved into the shared layout
 * (appointment-email-layout.ts) used by all four lifecycle emails; for the same
 * inputs the output is byte-identical to before. The confirmation can now also carry
 * the booked staff name(s) and the branch phone when the worker supplies them.
 *
 * What the email carries — and nothing else: the salon's name, a headline of
 * "{first name}, randevunuz onaylandı ✓" (or plain "Randevunuz onaylandı ✓") that
 * doubles as the greeting, the appointment date and time in the SALON'S OWN
 * timezone, the service name(s), optionally the staff name(s) and the branch phone,
 * and — only when the branch has a valid https location link — a "Yol Tarifi Al"
 * button. No notes, no prices, no internal ids, no roles, no marketing call to
 * action, no tracking pixel, no remote image, no remote font. The customer's name
 * never appears in the subject or preheader (both can surface in a lock-screen
 * preview) — only in the headline, inside the opened email.
 */
export type AppointmentConfirmationTemplateInput = AppointmentEmailInput;

export type AppointmentConfirmationEmailContent = AppointmentEmailContent;

export { formatAppointmentDisplay, formatGreetingName };
export type { AppointmentDisplayParts };

export function buildAppointmentConfirmationEmail(
  input: AppointmentConfirmationTemplateInput,
): AppointmentConfirmationEmailContent {
  const salonName = cleanSalonName(input.salonName);
  const greetingName = formatGreetingName(input.greetingName);
  const { dateLine, time } = formatAppointmentDisplay(input.appointmentStartAt, input.tenantTimezone);
  const locationUrl = sanitizeEmailLocationUrl(input.locationUrl);

  const subject = `Randevunuz Onaylandı — ${salonName}`;
  // The headline itself is the greeting: named when a greetingName exists, generic
  // otherwise. No Turkish locative suffix on the salon name (which one is grammatical
  // depends on the name's own vowel harmony): the sentence is phrased so the name
  // never takes a suffix.
  const headlineLead = greetingName ? `${greetingName}, randevunuz` : "Randevunuz";

  return renderAppointmentEmail({
    subject,
    salonName,
    preheader: `Randevunuz onaylandı · ${dateLine}, ${time}`,
    headlineLead,
    headlineTail: "onaylandı",
    headlineMark: "check",
    intro: [`Randevunuz ${salonName} tarafından onaylandı.`, "Sizi ağırlamak için sabırsızlanıyoruz."],
    dateLabel: "TARİH VE SAAT",
    dateLine,
    time,
    services: cleanServiceNames(input.serviceNames),
    staffNames: cleanStaffNames(input.staffNames),
    contactPhone: sanitizeContactPhone(input.contactPhone),
    button: locationUrl ? { label: "Yol Tarifi Al", url: locationUrl, textLabel: "Yol tarifi" } : null,
    footer:
      "Bu ileti randevu onayınız için otomatik olarak gönderilmiştir; lütfen yanıtlamayınız. Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.",
    textFooter: [
      "Bu ileti randevu onayınız için otomatik olarak gönderilmiştir; lütfen yanıtlamayınız.",
      "Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.",
    ],
  });
}
