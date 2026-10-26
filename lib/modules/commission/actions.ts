"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";

/**
 * Faz COMM.1A — set one commission rule (staff + service). One RPC; the database is the whole authorization boundary
 * (finance.manage of that salon) and validates the value again. The percentage / amount is passed through as the number the
 * Owner typed: the application never computes a commission.
 */
const schema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string().min(1).max(63),
  staffId: z.string().uuid(),
  serviceId: z.string().uuid(),
  kind: z.enum(["none", "percentage", "fixed"]),
  value: z.number().min(0).max(999999.99).nullable(),
  effectiveFrom: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).nullable(),
});

export async function setCommissionRuleAction(_prev: ActionResult<null> | null, input: unknown): Promise<ActionResult<null>> {
  await requireUser();
  const parsed = schema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", "Girdiğiniz bilgiler geçersiz, lütfen kontrol edin");
  const v = parsed.data;
  if ((v.kind === "none") !== (v.value === null)) return fail("VALIDATION", v.kind === "none" ? "Komisyon yok seçeneğinde değer girilmez" : "Bir değer girin");
  if (v.kind === "percentage" && (v.value ?? 0) > 100) return fail("VALIDATION", "Yüzde 0 ile 100 arasında olmalı");
  const supabase = await createClient();
  const { error } = await supabase.rpc("set_commission_rule", {
    p_tenant_id: v.tenantId,
    p_staff_id: v.staffId,
    p_service_id: v.serviceId,
    p_kind: v.kind,
    ...(v.value !== null ? { p_value: v.value } : {}),
    ...(v.effectiveFrom ? { p_effective_from: v.effectiveFrom } : {}),
  });
  if (error) {
    switch (error.code) {
      case "CM001":
        return fail("UNAUTHENTICATED", "Oturumunuz kapanmış, lütfen tekrar giriş yapın");
      case "CM002":
      case "42501":
        return fail("UNAUTHORIZED", "Komisyon kuralı değiştirme yetkiniz yok");
      case "CM003":
        return fail("NOT_FOUND", "Personel ya da hizmet bulunamadı");
      case "CM004":
        return fail("VALIDATION", "Girdiğiniz bilgiler kabul edilmedi, lütfen kontrol edin");
      default:
        return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
    }
  }
  revalidatePath(`/app/${v.tenantSlug}/finance/commission`);
  return ok(null);
}
