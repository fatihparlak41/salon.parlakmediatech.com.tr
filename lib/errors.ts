/**
 * Shared error shape for the data/domain layer (lib/modules/*, Server
 * Actions, Route Handlers — added from Faz 1 onward). Carries a stable,
 * machine-readable `code` rather than a hardcoded message so the UI layer
 * can map it through next-intl instead of baking Turkish strings into
 * code thrown deep in the data layer.
 */
export type AppErrorCode =
  | "UNAUTHENTICATED"
  | "UNAUTHORIZED"
  | "NOT_FOUND"
  | "VALIDATION"
  | "CONFLICT"
  | "UNEXPECTED";

export class AppError extends Error {
  readonly code: AppErrorCode;

  constructor(
    code: AppErrorCode,
    message: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "AppError";
    this.code = code;
  }
}

/**
 * Return type for Server Actions. Prefer returning this over throwing:
 * a thrown error crossing the Server Action boundary is reduced to a
 * generic message in production, losing the `code` the UI needs.
 */
export type ActionResult<T> =
  | { success: true; data: T }
  | { success: false; error: { code: AppErrorCode; message: string } };

export function ok<T>(data: T): ActionResult<T> {
  return { success: true, data };
}

export function fail<T = never>(
  code: AppErrorCode,
  message: string,
): ActionResult<T> {
  return { success: false, error: { code, message } };
}
