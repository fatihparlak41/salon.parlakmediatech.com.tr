import { getTranslations } from "next-intl/server";
import { createClient } from "@/lib/supabase/server";
import { updateTenantStatusAction } from "@/lib/modules/platform/actions";
import { listTenantOwnerApprovals } from "@/lib/modules/platform/approvals";
import { TenantOwnerApprovals } from "@/components/platform/tenant-owner-approvals";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";

export default async function SuperAdminPage() {
  const t = await getTranslations("SuperAdmin");
  const supabase = await createClient();

  // Platform-scope query — no tenant_id filter. Allowed only because the
  // tenants SELECT policy grants platform_admin cross-tenant read (see
  // 20260815120016_rls_policies_identity.sql); a regular tenant member
  // hitting this same query would only ever get their own tenant(s) back.
  const { data: tenants } = await supabase
    .from("tenants")
    .select("id, name, slug, status, created_at")
    .is("deleted_at", null)
    .order("created_at", { ascending: false });

  // Faz LAUNCH.1A — owner approvals for creating a salon. Answered only to a
  // platform OWNER; any other admin gets { allowed: false } and no section.
  const approvals = await listTenantOwnerApprovals(supabase);
  const tApprovals = await getTranslations("SuperAdmin.approvals");

  return (
    <div className="mx-auto w-full max-w-3xl px-6 py-16">
      <Badge variant="secondary">/super-admin</Badge>
      <h1 className="mt-4 text-2xl font-semibold tracking-tight">
        {t("title")}
      </h1>

      <h2 className="text-muted-foreground mt-8 mb-3 text-sm font-medium">
        {t("tenantsHeading")}
      </h2>

      {!tenants || tenants.length === 0 ? (
        <p className="text-muted-foreground text-sm">{t("empty")}</p>
      ) : (
        <div className="border-border overflow-x-auto rounded-lg border">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>{t("columns.name")}</TableHead>
                <TableHead>{t("columns.slug")}</TableHead>
                <TableHead>{t("columns.status")}</TableHead>
                <TableHead>{t("columns.createdAt")}</TableHead>
                <TableHead />
              </TableRow>
            </TableHeader>
            <TableBody>
              {tenants.map((tenant) => (
                <TableRow key={tenant.id}>
                  <TableCell className="font-medium">{tenant.name}</TableCell>
                  <TableCell className="font-mono text-xs">
                    {tenant.slug}
                  </TableCell>
                  <TableCell>
                    <Badge
                      variant={
                        tenant.status === "active" ? "default" : "secondary"
                      }
                    >
                      {tenant.status}
                    </Badge>
                  </TableCell>
                  <TableCell className="text-muted-foreground">
                    {new Date(tenant.created_at).toLocaleDateString("tr-TR")}
                  </TableCell>
                  <TableCell className="text-right">
                    <form action={updateTenantStatusAction}>
                      <input type="hidden" name="tenantId" value={tenant.id} />
                      <input
                        type="hidden"
                        name="status"
                        value={
                          tenant.status === "suspended" ? "active" : "suspended"
                        }
                      />
                      <Button type="submit" variant="outline" size="sm">
                        {tenant.status === "suspended"
                          ? t("statusActions.activate")
                          : t("statusActions.suspend")}
                      </Button>
                    </form>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      )}

      {approvals.allowed ? (
        <TenantOwnerApprovals
          rows={approvals.rows}
          labels={{
            heading: tApprovals("heading"),
            description: tApprovals("description"),
            emailLabel: tApprovals("emailLabel"),
            noteLabel: tApprovals("noteLabel"),
            daysLabel: tApprovals("daysLabel"),
            daysOptions: [7, 14, 30, 60, 90].map((count) => ({ value: count, label: tApprovals("daysOption", { count }) })),
            submit: tApprovals("submit"),
            submitting: tApprovals("submitting"),
            approvedMessage: tApprovals("approvedMessage"),
            revokedMessage: tApprovals("revokedMessage"),
            revoke: tApprovals("revoke"),
            revoking: tApprovals("revoking"),
            empty: tApprovals("empty"),
            columns: {
              email: tApprovals("columns.email"),
              note: tApprovals("columns.note"),
              status: tApprovals("columns.status"),
              expires: tApprovals("columns.expires"),
              salon: tApprovals("columns.salon"),
              actions: tApprovals("columns.actions"),
            },
            status: {
              approved: tApprovals("status.approved"),
              expired: tApprovals("status.expired"),
              consumed: tApprovals("status.consumed"),
              revoked: tApprovals("status.revoked"),
            },
          }}
        />
      ) : (
        <p className="text-muted-foreground mt-12 text-sm">{tApprovals("ownerOnly")}</p>
      )}
    </div>
  );
}
