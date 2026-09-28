/**
 * Faz ACCOUNT.1 — the four per-membership notification categories the
 * database already stores (notification_preferences, Faz NOTIF.2A) and the
 * delivery worker already honours when it picks recipients
 * (private.materialize_notification_deliveries / claim_notification_delivery_targets).
 *
 * Framework-free and free of `server-only`, so the account page (a Server
 * Component), the Server Action and the client toggle list can all share
 * one definition of the key set without any of them importing another's
 * runtime.
 *
 * Mapping to the event types the worker fans out (V1 locked set):
 *   newAppointment   <- appointment.created
 *   cancellation     <- appointment.cancelled
 *   reschedule       <- appointment.rescheduled
 *   assignmentChange <- appointment.staff_reassigned
 * There is deliberately no "reminder" key: no reminder event exists in the
 * pipeline, and a toggle that stored a preference no code ever reads would
 * only mislead people.
 */

export const NOTIFICATION_PREFERENCE_KEYS = [
  "newAppointment",
  "cancellation",
  "reschedule",
  "assignmentChange",
] as const;

export type NotificationPreferenceKey = (typeof NOTIFICATION_PREFERENCE_KEYS)[number];

export type NotificationPreferences = Record<NotificationPreferenceKey, boolean>;

/**
 * get_my_notification_preferences / update_my_notification_preferences
 * return exactly these four booleans as jsonb. Anything else (null, a
 * missing key, a non-boolean) is treated as "unknown" rather than
 * defaulted here — the database owns the all-true default for a
 * membership with no row, this parser must not invent one.
 */
export function parseNotificationPreferences(value: unknown): NotificationPreferences | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Record<string, unknown>;
  const result = {} as NotificationPreferences;
  for (const key of NOTIFICATION_PREFERENCE_KEYS) {
    const flag = record[key];
    if (typeof flag !== "boolean") return null;
    result[key] = flag;
  }
  return result;
}
