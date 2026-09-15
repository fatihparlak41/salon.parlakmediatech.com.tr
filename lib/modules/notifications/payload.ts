import "server-only";

/**
 * Faz NOTIF.2E.2 Steps 9/10 — privacy-safe push payload + click path.
 *
 * Step 9: no customer name, phone, email, or notes — ever. The four
 * fixed Turkish bodies below are the exact copy given for V1; this
 * migration deliberately does NOT expand notification_events' own
 * contract to enrich these (e.g. with appointment local time/service)
 * without stopping and reporting first, per that step's own explicit
 * instruction — flagged plainly in this phase's final report rather than
 * silently decided either way.
 *
 * Step 10: there is no `?appointment=<id>` deep-link convention
 * anywhere in this app (confirmed by audit — components/dashboard/
 * today-schedule.tsx's own AppointmentDetailSheet is local-state-driven,
 * never URL-driven). /app/[tenantSlug]/appointments is an existing,
 * authenticated, tenant-scoped, same-origin route — confirmed live
 * during the DASHBOARD.1 PROD release's own public/authenticated smoke
 * testing this session, rendering correctly with no locale prefix
 * required. public/sw-helpers.js's safeNotificationTargetPath already
 * restricts any click target to exactly this shape (single-slash-rooted,
 * same-origin, no scheme) — no Service Worker change is needed for this
 * path to work correctly.
 */

export type NotificationEventType =
  | "appointment.created"
  | "appointment.cancelled"
  | "appointment.rescheduled"
  | "appointment.staff_reassigned";

export type DeliveryPushPayload = { title: string; body: string; path: string };

const EVENT_BODY_TR: Record<string, string> = {
  "appointment.created": "Yeni randevu oluşturuldu.",
  "appointment.cancelled": "Bir randevu iptal edildi.",
  "appointment.rescheduled": "Bir randevu güncellendi.",
  "appointment.staff_reassigned": "Bir randevunun personel ataması değişti.",
};

const FALLBACK_BODY_TR = "Bildiriminiz var.";

export function buildDeliveryPushPayload(eventType: string, tenantSlug: string): DeliveryPushPayload {
  return {
    title: "SalonOS",
    body: EVENT_BODY_TR[eventType] ?? FALLBACK_BODY_TR,
    path: `/app/${tenantSlug}/appointments`,
  };
}
