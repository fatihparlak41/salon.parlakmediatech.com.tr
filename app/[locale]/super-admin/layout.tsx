/**
 * Faz 1 adds the real guard here: platform_admins membership check,
 * entirely independent of tenant_memberships (see architecture report,
 * section E). For now this only proves the /super-admin segment resolves.
 */
export default function SuperAdminLayout({
  children,
}: LayoutProps<"/[locale]/super-admin">) {
  return children;
}
