"use server";

import { revalidatePath } from "next/cache";
import { z } from "zod";
import { createClient } from "@/lib/supabase/server";
import { requireUser } from "@/lib/auth/session";
import { fail, ok, type ActionResult } from "@/lib/errors";
import { parseImportCommit, parseImportPreview, type ImportCommit, type ImportPreview } from "./import-model";
import { MAX_IMPORT_ROWS } from "./import-csv";

/**
 * Faz CUST.1A — customer import Server Actions. Both call exactly one RPC; the database is the whole authorization boundary
 * (customers.view/create/update + settings.manage of THAT salon) and the only place classification happens. The uploaded
 * rows are passed through and discarded: nothing is logged, nothing is stored by the application.
 */

const importSchema = z.object({
  tenantId: z.string().uuid(),
  tenantSlug: z.string().min(1).max(63),
  rows: z
    .array(
      z.object({
        row: z.number().int().min(1).max(1_000_000),
        name: z.string().max(1000),
        phone: z.string().max(200),
        email: z.string().max(500),
      }),
    )
    .min(1, "Dosyada aktarılacak satır yok")
    .max(MAX_IMPORT_ROWS, `Bir seferde en fazla ${MAX_IMPORT_ROWS} satır aktarılabilir`),
});

function mapError(error: { code?: string }): ActionResult<never> {
  switch (error.code) {
    case "CI010":
      return fail("UNAUTHENTICATED", "Oturumunuz kapanmış, lütfen tekrar giriş yapın");
    case "CI011":
    case "42501":
      return fail("UNAUTHORIZED", "Müşteri listesi aktarma yetkiniz yok");
    case "CI012":
      return fail("VALIDATION", "Dosya kabul edilmedi, lütfen kontrol edin");
    default:
      return fail("UNEXPECTED", "İşlem gerçekleştirilemedi, lütfen tekrar deneyin");
  }
}

export async function previewCustomerImportAction(_prev: ActionResult<ImportPreview> | null, input: unknown): Promise<ActionResult<ImportPreview>> {
  await requireUser();
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz dosya");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("preview_customer_import", { p_tenant_id: parsed.data.tenantId, p_rows: parsed.data.rows });
  if (error) return mapError(error);
  const preview = parseImportPreview(data);
  return preview ? ok(preview) : fail("UNEXPECTED", "Önizleme okunamadı, lütfen tekrar deneyin");
}

export async function commitCustomerImportAction(_prev: ActionResult<ImportCommit> | null, input: unknown): Promise<ActionResult<ImportCommit>> {
  await requireUser();
  const parsed = importSchema.safeParse(input);
  if (!parsed.success) return fail("VALIDATION", parsed.error.issues[0]?.message ?? "Geçersiz dosya");
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("commit_customer_import", { p_tenant_id: parsed.data.tenantId, p_rows: parsed.data.rows });
  if (error) return mapError(error);
  const result = parseImportCommit(data);
  if (!result) return fail("UNEXPECTED", "Sonuç okunamadı; müşteri listesini kontrol edin");
  revalidatePath(`/app/${parsed.data.tenantSlug}/customers`);
  return ok(result);
}
