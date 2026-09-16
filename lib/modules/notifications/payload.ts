import "server-only";
import { utcIsoToTenantLocalParts } from "@/lib/modules/appointments/timezone";

/**
 * Faz NOTIF.2E.2 Steps 9/10 + Faz NOTIF.2F.1 — push payload + click path.
 *
 * Rich copy renders customer name / service summary / tenant-local
 * appointment time whenever a display snapshot is available
 * (notification_event_display_snapshots, via claim_notification_
 * delivery_targets — never a live join to customers/services/
 * appointments here). Any event with no usable snapshot (every
 * pre-2F.1 historical event, or the rare defensive case of a snapshot
 * row missing its own appointmentStartAt) falls back to the exact
 * generic Turkish copy this file shipped before 2F.1 — same fixed
 * per-event body, "SalonOS" title — never a malformed partial render.
 *
 * Step 10 (unchanged from 2E.2): there is no `?appointment=<id>`
 * deep-link convention anywhere in this app. /app/[tenantSlug]/
 * appointments is an existing, authenticated, tenant-scoped, same-origin
 * route; public/sw-helpers.js's safeNotificationTargetPath already
 * restricts any click target to exactly this shape. Not changed by
 * NOTIF.2F.1 — the click destination is out of scope for this phase.
 */

export type NotificationEventType =
  | "appointment.created"
  | "appointment.cancelled"
  | "appointment.rescheduled"
  | "appointment.staff_reassigned";

export type DeliveryPushPayload = { title: string; body: string; path: string };

export type DisplaySnapshotInput = {
  customerName: string | null;
  serviceNames: string[] | null;
  appointmentStartAt: string | null;
  tenantTimezone: string | null;
};

// Pre-2F.1 generic copy — unchanged, kept verbatim as the backward-
// compatibility fallback for any event with no display snapshot.
const GENERIC_TITLE_TR = "SalonOS";
const EVENT_BODY_TR: Record<string, string> = {
  "appointment.created": "Yeni randevu oluşturuldu.",
  "appointment.cancelled": "Bir randevu iptal edildi.",
  "appointment.rescheduled": "Bir randevu güncellendi.",
  "appointment.staff_reassigned": "Bir randevunun personel ataması değişti.",
};
const FALLBACK_BODY_TR = "Bildiriminiz var.";

// Faz NOTIF.2F.1 rich-copy titles — never "SalonOS" for these 4 event
// types once a usable snapshot exists; the app/icon already carries the
// brand.
const EVENT_TITLE_TR: Record<string, string> = {
  "appointment.created": "Yeni randevu",
  "appointment.cancelled": "Randevu iptal edildi",
  "appointment.rescheduled": "Randevu güncellendi",
  "appointment.staff_reassigned": "Personel değişti",
};

const CUSTOMER_FALLBACK_TR = "Müşteri";
const SERVICE_FALLBACK_TR = "Randevu";

const TR_MONTH_ABBR = ["Oca", "Şub", "Mar", "Nis", "May", "Haz", "Tem", "Ağu", "Eyl", "Eki", "Kas", "Ara"];

function genericPayload(eventType: string, path: string): DeliveryPushPayload {
  return { title: GENERIC_TITLE_TR, body: EVENT_BODY_TR[eventType] ?? FALLBACK_BODY_TR, path };
}

/** Collapses newlines/tabs/other control characters and repeated
 * whitespace to a single space, then trims — the one sanitizer applied
 * to every customer/service string right before it reaches the payload,
 * so a lock-screen notification can never become multi-line or
 * malformed regardless of what made it into the snapshot row. */
function sanitizeDisplayText(value: string | null | undefined): string {
  if (!value) return "";
  // Deliberately matches control characters (NUL..US, DEL) alongside \s
  // to collapse them into a single space.
  return value.replace(/[\x00-\x1F\x7F\s]+/g, " ").trim();
}

/** Reuses the tenant-timezone conversion primitive already established
 * in lib/modules/appointments/timezone.ts (Intl-based, DST-correct) —
 * only the Turkish short-date rendering on top is new. No day
 * zero-padding ("7 Eki", not "07 Eki"); hour/minute stay zero-padded
 * ("09:00") since utcIsoToTenantLocalParts already produces that. */
function formatTurkishPushDateTime(isoString: string, tenantTz: string): string {
  const { date, time } = utcIsoToTenantLocalParts(isoString, tenantTz);
  const [, monthStr, dayStr] = date.split("-");
  const day = String(Number(dayStr));
  const month = TR_MONTH_ABBR[Number(monthStr) - 1];
  return `${day} ${month} ${time}`;
}

/** "Saç Kesimi" for one service, "Saç Kesimi +1 hizmet" for more — never
 * lists every service (kept compact per this phase's own instruction).
 * Falls back to "Randevu" when no usable service name survives
 * sanitization. */
function buildServiceSummary(serviceNames: string[] | null): string {
  const cleaned = (serviceNames ?? []).map(sanitizeDisplayText).filter((name) => name.length > 0);
  if (cleaned.length === 0) return SERVICE_FALLBACK_TR;
  if (cleaned.length === 1) return cleaned[0]!;
  return `${cleaned[0]} +${cleaned.length - 1} hizmet`;
}

export function buildDeliveryPushPayload(
  eventType: string,
  tenantSlug: string,
  snapshot?: DisplaySnapshotInput | null,
): DeliveryPushPayload {
  const path = `/app/${tenantSlug}/appointments`;
  const title = EVENT_TITLE_TR[eventType];

  // No snapshot at all, no usable appointment time, or an event type
  // this phase doesn't define rich copy for (defensive — every real
  // event_type today has one) — fall back to the exact pre-2F.1 generic
  // copy rather than ever rendering a body missing its final segment.
  if (!snapshot || !snapshot.appointmentStartAt || !snapshot.tenantTimezone || !title) {
    return genericPayload(eventType, path);
  }

  const customerName = sanitizeDisplayText(snapshot.customerName) || CUSTOMER_FALLBACK_TR;
  const serviceSummary = buildServiceSummary(snapshot.serviceNames);
  const localDateTime = formatTurkishPushDateTime(snapshot.appointmentStartAt, snapshot.tenantTimezone);

  return { title, body: `${customerName} · ${serviceSummary} · ${localDateTime}`, path };
}
