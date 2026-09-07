/**
 * Availability, not routing: this still answers "which statuses can this
 * appointment move to next" (completed/cancelled are terminal; every
 * other status may move to any of the five targets), matching
 * private.update_appointment_status's terminal-state rule exactly. As of
 * Faz 5A.2, "completed" being available here no longer means
 * update_appointment_status will accept it — that RPC now rejects
 * 'completed' unconditionally (AP017, 20260905150000, closed completion
 * bypass); reaching it goes only through complete_appointment
 * (Faz 5A.1). getAvailableStatusTransitions still correctly drives
 * whether the UI's "Tamamlandı" control renders at all
 * (appointment-detail-sheet.tsx's StatusActions), it just no longer
 * implies which RPC a click on it should call — that split is the
 * caller's job now, not this module's.
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
