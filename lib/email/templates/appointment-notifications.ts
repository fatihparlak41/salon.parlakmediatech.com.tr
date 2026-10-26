import { sanitizeEmailLocationUrl } from "@/lib/email/location-url";
import {
  cleanPreparationNote,
  cleanSalonName,
  cleanServiceNames,
  cleanStaffNames,
  formatAppointmentDisplay,
  formatGreetingName,
  localDayDifference,
  renderAppointmentEmail,
  sanitizeContactPhone,
  type AppointmentEmailContent,
  type AppointmentEmailInput,
} from "@/lib/email/templates/appointment-email-layout";
import { buildAppointmentConfirmationEmail } from "@/lib/email/templates/appointment-confirmation";

/**
 * Faz LAUNCH.1B — the change, cancellation and 24 h reminder emails (Turkish). Pure:
 * the same contract as the confirmation template (no Supabase import, no env reads,
 * no database access, no logging) and the same shared layout. They carry the salon
 * name, a headline (named when a first name exists), the appointment date and time
 * in the SALON'S timezone, the service names, optionally staff names and the branch
 * phone, and at most one button. They never carry notes, prices, internal ids,
 * tenant ids, auth ids or roles.
 */

export type CustomerNotificationType =
  | "appointment_confirmation"
  | "appointment_update"
  | "appointment_cancellation"
  | "appointment_reminder_24h";

export const CUSTOMER_NOTIFICATION_TYPES: readonly CustomerNotificationType[] = [
  "appointment_confirmation",
  "appointment_update",
  "appointment_cancellation",
  "appointment_reminder_24h",
];

export type CustomerNotificationEmailInput = AppointmentEmailInput & {
  /** The send instant, used only to say "yarın" / "bugün" in the reminder. */
  referenceInstant: string;
  /** Public booking page of the salon (https), used by the cancellation email. */
  rebookUrl: string | null;
};

const AUTOMATIC_FOOTER_TAIL = "lütfen yanıtlamayınız.";

function leadFor(greetingName: string | null, rest: string): string {
  return greetingName ? `${greetingName}, ${rest}` : `${rest.charAt(0).toLocaleUpperCase("tr-TR")}${rest.slice(1)}`;
}

export function buildAppointmentUpdateEmail(input: CustomerNotificationEmailInput): AppointmentEmailContent {
  const salonName = cleanSalonName(input.salonName);
  const greetingName = formatGreetingName(input.greetingName);
  const { dateLine, time } = formatAppointmentDisplay(input.appointmentStartAt, input.tenantTimezone);
  const locationUrl = sanitizeEmailLocationUrl(input.locationUrl);

  return renderAppointmentEmail({
    subject: `Randevunuz Güncellendi — ${salonName}`,
    salonName,
    preheader: `Randevunuz güncellendi · ${dateLine}, ${time}`,
    headlineLead: leadFor(greetingName, "randevunuz"),
    headlineTail: "güncellendi",
    headlineMark: null,
    intro: [`${salonName} randevunuzda bir değişiklik yaptı.`, "Güncel randevu bilgileriniz aşağıdadır."],
    dateLabel: "GÜNCEL TARİH VE SAAT",
    dateLine,
    time,
    services: cleanServiceNames(input.serviceNames),
    staffNames: cleanStaffNames(input.staffNames),
    contactPhone: sanitizeContactPhone(input.contactPhone),
    button: locationUrl ? { label: "Yol Tarifi Al", url: locationUrl, textLabel: "Yol tarifi" } : null,
    footer: `Bu ileti randevunuzdaki değişiklik nedeniyle otomatik olarak gönderilmiştir; ${AUTOMATIC_FOOTER_TAIL} Bir sorunuz varsa lütfen salonla iletişime geçin.`,
    textFooter: [
      `Bu ileti randevunuzdaki değişiklik nedeniyle otomatik olarak gönderilmiştir; ${AUTOMATIC_FOOTER_TAIL}`,
      "Bir sorunuz varsa lütfen salonla iletişime geçin.",
    ],
  });
}

export function buildAppointmentCancellationEmail(input: CustomerNotificationEmailInput): AppointmentEmailContent {
  const salonName = cleanSalonName(input.salonName);
  const greetingName = formatGreetingName(input.greetingName);
  const { dateLine, time } = formatAppointmentDisplay(input.appointmentStartAt, input.tenantTimezone);
  const rebookUrl = sanitizeEmailLocationUrl(input.rebookUrl);

  return renderAppointmentEmail({
    subject: `Randevunuz İptal Edildi — ${salonName}`,
    salonName,
    preheader: `Randevunuz iptal edildi · ${dateLine}, ${time}`,
    headlineLead: leadFor(greetingName, "randevunuz"),
    headlineTail: "iptal edildi",
    headlineMark: null,
    intro: [
      `${salonName} için aşağıdaki randevunuz iptal edildi.`,
      rebookUrl ? "Dilerseniz yeni bir randevu oluşturabilirsiniz." : "Yeni bir randevu için lütfen salonla iletişime geçin.",
    ],
    dateLabel: "İPTAL EDİLEN RANDEVU",
    dateLine,
    time,
    services: cleanServiceNames(input.serviceNames),
    staffNames: cleanStaffNames(input.staffNames),
    contactPhone: sanitizeContactPhone(input.contactPhone),
    button: rebookUrl ? { label: "Yeniden Randevu Al", url: rebookUrl, textLabel: "Yeni randevu" } : null,
    footer: `Bu ileti randevunuzun iptali nedeniyle otomatik olarak gönderilmiştir; ${AUTOMATIC_FOOTER_TAIL}`,
    textFooter: [`Bu ileti randevunuzun iptali nedeniyle otomatik olarak gönderilmiştir; ${AUTOMATIC_FOOTER_TAIL}`],
  });
}

export function buildAppointmentReminderEmail(input: CustomerNotificationEmailInput): AppointmentEmailContent {
  const salonName = cleanSalonName(input.salonName);
  const greetingName = formatGreetingName(input.greetingName);
  const { dateLine, time } = formatAppointmentDisplay(input.appointmentStartAt, input.tenantTimezone);
  const locationUrl = sanitizeEmailLocationUrl(input.locationUrl);

  // "Yarın" only when the appointment really is on the salon's NEXT local day; a
  // reminder that went out late (inside its window) may be for the same local day.
  const days = localDayDifference(input.referenceInstant, input.appointmentStartAt, input.tenantTimezone);
  const dayWord = days === 0 ? "bugün" : days === 1 ? "yarın" : null;
  const headlineLead = greetingName
    ? dayWord
      ? `${greetingName}, ${dayWord}`
      : `${greetingName},`
    : dayWord
      ? `${dayWord.charAt(0).toLocaleUpperCase("tr-TR")}${dayWord.slice(1)}`
      : "Yaklaşan";
  const headlineTail = dayWord ? "randevunuz var" : "randevunuzu hatırlatırız";
  const subjectLead = dayWord ? `${dayWord.charAt(0).toLocaleUpperCase("tr-TR")}${dayWord.slice(1)} Randevunuz Var` : "Randevu Hatırlatması";

  return renderAppointmentEmail({
    subject: `${subjectLead} — ${salonName}`,
    salonName,
    preheader: `${dayWord ? `${dayWord.charAt(0).toLocaleUpperCase("tr-TR")}${dayWord.slice(1)} randevunuz var` : "Randevu hatırlatması"} · ${dateLine}, ${time}`,
    headlineLead: headlineLead.trimEnd(),
    headlineTail,
    headlineMark: null,
    intro: [`${salonName} ile randevunuzu hatırlatmak isteriz.`, "Sizi ağırlamak için sabırsızlanıyoruz."],
    dateLabel: "TARİH VE SAAT",
    dateLine,
    time,
    services: cleanServiceNames(input.serviceNames),
    staffNames: cleanStaffNames(input.staffNames),
    contactPhone: sanitizeContactPhone(input.contactPhone),
    preparationNote: cleanPreparationNote(input.preparationNote),
    button: locationUrl ? { label: "Yol Tarifi Al", url: locationUrl, textLabel: "Yol tarifi" } : null,
    footer: `Bu ileti randevu hatırlatması olarak otomatik gönderilmiştir; ${AUTOMATIC_FOOTER_TAIL} Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.`,
    textFooter: [
      `Bu ileti randevu hatırlatması olarak otomatik gönderilmiştir; ${AUTOMATIC_FOOTER_TAIL}`,
      "Randevunuzla ilgili bir değişiklik için lütfen salonla iletişime geçin.",
    ],
  });
}

/** The single dispatch point the worker uses. An unknown type is a programming error,
 * not a customer-visible condition: it throws (the worker records `render_error`). */
export function buildCustomerNotificationEmail(
  type: CustomerNotificationType,
  input: CustomerNotificationEmailInput,
): AppointmentEmailContent {
  switch (type) {
    case "appointment_confirmation":
      return buildAppointmentConfirmationEmail(input);
    case "appointment_update":
      return buildAppointmentUpdateEmail(input);
    case "appointment_cancellation":
      return buildAppointmentCancellationEmail(input);
    case "appointment_reminder_24h":
      return buildAppointmentReminderEmail(input);
    default: {
      const unreachable: never = type;
      throw new Error(`unknown customer notification type: ${String(unreachable)}`);
    }
  }
}
