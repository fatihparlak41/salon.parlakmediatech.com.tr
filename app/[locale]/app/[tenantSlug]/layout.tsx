import { notFound, redirect } from "next/navigation";
import { getTenantAccess } from "@/lib/auth/session";

export default async function TenantAppLayout({
  children,
  params,
}: LayoutProps<"/[locale]/app/[tenantSlug]">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);

  if (access.reason === "unauthenticated") {
    redirect("/login");
  }
  if (access.reason === "not_found") {
    // Also covers "authenticated but not a member" — never confirms to an
    // unauthorized user whether this tenant slug exists.
    notFound();
  }

  return children;
}
