import { requirePlatformAdmin } from "@/lib/auth/session";

export default async function SuperAdminLayout({
  children,
}: LayoutProps<"/[locale]/super-admin">) {
  // Independent of tenant_memberships entirely — see architecture report
  // section E. A tenant owner is never a platform admin by virtue of
  // owning a tenant, no matter how permissive their role is.
  await requirePlatformAdmin();
  return children;
}
