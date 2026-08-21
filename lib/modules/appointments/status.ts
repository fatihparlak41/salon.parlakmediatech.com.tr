/**
 * Mirrors private.update_appointment_status's actual transition rule
 * (20260819052733, untouched by 20260822090000's error-code addition) —
 * not a second, independently-invented state machine. The DB logic is
 * exactly: completed/cancelled are terminal (reject any change); every
 * other status may move to any of the five target statuses. This module
 * exists so the UI shows only sensible buttons; the RPC call this feeds
 * remains the actual authority regardless of what this computes.
 */
export const APPOINTMENT_STATUSES = [
  "scheduled",
  "confirmed",
  "in_progress",
  "completed",
  "cancelled",
  "no_show",
] as const;

export type AppointmentStatus = (typeof APPOINTMENT_STATUSES)[number];

// Valid targets for update_appointment_status's p_new_status — deliberately
// excludes "scheduled", which is only ever the row's initial default and
// never a valid RPC target. A distinct type (not just AppointmentStatus)
// so callers passing a transition straight into the action get a
// compile-time guarantee it can never be "scheduled".
export type AppointmentTransitionTarget = Exclude<AppointmentStatus, "scheduled">;

const TARGET_STATUSES: AppointmentTransitionTarget[] = ["confirmed", "in_progress", "completed", "cancelled", "no_show"];

const TERMINAL_STATUSES: ReadonlySet<AppointmentStatus> = new Set(["completed", "cancelled"]);

export const STATUS_LABELS_TR: Record<AppointmentStatus, string> = {
  scheduled: "Planlandı",
  confirmed: "Onaylandı",
  in_progress: "Devam ediyor",
  completed: "Tamamlandı",
  cancelled: "İptal edildi",
  no_show: "Gelmedi",
};

export function isTerminalStatus(status: string): boolean {
  return TERMINAL_STATUSES.has(status as AppointmentStatus);
}

/** Statuses worth offering as a one-click transition from the current
 * one — terminal statuses offer none, everything else offers every valid
 * target except its own current value. */
export function getAvailableStatusTransitions(currentStatus: string): AppointmentTransitionTarget[] {
  if (isTerminalStatus(currentStatus)) return [];
  return TARGET_STATUSES.filter((s) => s !== currentStatus);
}
