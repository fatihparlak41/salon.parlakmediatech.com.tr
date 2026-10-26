import { redirect } from "next/navigation";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { CustomerImport } from "@/components/customers/customer-import";

/**
 * Faz CUST.1A — the Owner's customer import. Opt-in page; the database re-checks the same permissions on every call.
 */
export default async function CustomerImportPage({ params }: PageProps<"/[locale]/app/[tenantSlug]/customers/import">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;
  const tenantId = access.tenant.id;
  const [view, create, update, settings] = await Promise.all([
    hasPermission(tenantId, "customers.view"),
    hasPermission(tenantId, "customers.create"),
    hasPermission(tenantId, "customers.update"),
    hasPermission(tenantId, "settings.manage"),
  ]);
  if (!(view && create && update && settings)) {
    redirect(`/app/${tenantSlug}/customers`);
  }
  return (
    <div className="mx-auto flex w-full max-w-3xl flex-col gap-5 px-4 py-8 sm:px-6">
      <div>
        <h1 className="font-heading text-xl font-semibold tracking-tight">Müşteri listesini içe aktar</h1>
        <p className="text-muted-foreground mt-1 text-sm">Mevcut müşteri listenizi güvenle aktarın. Önce önizleme görürsünüz; onaylamadan hiçbir kayıt yapılmaz.</p>
      </div>
      <CustomerImport tenantId={tenantId} tenantSlug={tenantSlug} />
    </div>
  );
}
