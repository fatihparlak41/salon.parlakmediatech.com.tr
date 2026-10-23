import { z } from "zod";

/** Faz LAUNCH.1A — input for the owner-approval section of /super-admin. The
 * database re-validates everything (private.platform_approve_tenant_owner);
 * this only gives a normal form error before the round trip. */
export const approveTenantOwnerSchema = z.object({
  email: z.string().trim().email("Geçerli bir e-posta adresi girin"),
  note: z.string().trim().max(500, "Not en fazla 500 karakter olabilir").optional(),
  validDays: z.coerce.number().int("Geçerlilik tam gün olmalı").min(1, "Geçerlilik en az 1 gün olmalı").max(90, "Geçerlilik en fazla 90 gün olabilir"),
});

export const revokeTenantOwnerApprovalSchema = z.object({
  approvalId: z.string().uuid("Geçersiz onay kaydı"),
});
