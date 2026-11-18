import { redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { getTenantAccess } from "@/lib/auth/session";
import { createClient } from "@/lib/supabase/server";
import { getTenantExportStatus } from "@/lib/modules/export/queries";
import { TenantExportPanel } from "@/components/export/tenant-export-panel";

/**
 * "Verilerimi dışa aktar" - Owner only. Authorization is the database's (public.get_tenant_export_status answers `allowed: false` to anyone who is
 * not an Owner of this salon); a Yönetici / Resepsiyon / Personel is simply sent back to the dashboard. This page is available in EVERY billing
 * state: leaving the product must never depend on an invoice.
 */
export default async function ExportPage({ params }: PageProps<"/[locale]/app/[tenantSlug]/export">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const supabase = await createClient();
  const status = await getTenantExportStatus(supabase, access.tenant.id);
  if (!status.allowed) redirect(`/app/${tenantSlug}`);

  const t = await getTranslations("Export");
  const fmt = (iso: string | null) => (iso ? new Intl.DateTimeFormat("tr-TR", { dateStyle: "medium", timeStyle: "short" }).format(new Date(iso)) : null);

  return (
    <div className="mx-auto flex max-w-2xl flex-col gap-6 p-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">{t("title")}</h1>
        <p className="text-muted-foreground mt-1 text-sm">{t("description")}</p>
      </div>
      <TenantExportPanel
        tenantSlug={tenantSlug}
        status={{ remaining: status.remaining, limit: status.limit, lastExportLabel: fmt(status.last_export_at), nextAvailableLabel: fmt(status.next_available_at), inProgress: status.in_progress }}
      />
    </div>
  );
}
