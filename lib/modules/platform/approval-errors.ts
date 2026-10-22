import { fail, type ActionResult } from "@/lib/errors";

/**
 * Faz LAUNCH.1A — maps the exact exception texts raised by
 * private.platform_approve_tenant_owner / platform_revoke_tenant_owner_approval
 * (migration 20261022150000) to user-facing results. Pure and synchronous on
 * purpose: lib/modules/platform/actions.ts is a "use server" file, which may
 * export only async functions.
 */
export function mapApprovalError(error: { message?: string } | null | undefined): ActionResult<never> {
  const msg = error?.message ?? "";
  if (msg.includes("authentication required")) {
    return fail("UNAUTHENTICATED", "Oturum açmanız gerekiyor");
  }
  if (msg.includes("platform_owner_required")) {
    return fail("UNAUTHORIZED", "Bu işlemi yalnızca platform sahibi yapabilir");
  }
  if (msg.includes("invalid_email")) {
    return fail("VALIDATION", "Geçerli bir e-posta adresi girin");
  }
  if (msg.includes("invalid_validity")) {
    return fail("VALIDATION", "Geçerlilik 1 ile 90 gün arasında olmalı");
  }
  if (msg.includes("note_too_long")) {
    return fail("VALIDATION", "Not en fazla 500 karakter olabilir");
  }
  if (msg.includes("approval_not_found")) {
    return fail("NOT_FOUND", "Onay kaydı bulunamadı");
  }
  if (msg.includes("approval_already_consumed")) {
    return fail("CONFLICT", "Bu onay zaten kullanıldı; salon oluşturulmuş");
  }
  return fail("UNEXPECTED", "İşlem tamamlanamadı, lütfen tekrar deneyin");
}
