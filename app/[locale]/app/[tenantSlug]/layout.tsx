/**
 * Faz 1 adds the real guard here: resolve tenantSlug -> tenant_id, verify
 * an active tenant_membership for the signed-in user, load permissions.
 * For now this only proves the /app/[tenantSlug] segment resolves.
 */
export default function TenantAppLayout({
  children,
}: LayoutProps<"/[locale]/app/[tenantSlug]">) {
  return children;
}
