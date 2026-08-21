import { notFound, redirect } from "next/navigation";
import { getTranslations } from "next-intl/server";
import { LayoutDashboard, Users, Scissors, Contact, CalendarClock } from "lucide-react";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { TenantAppShell, type TenantNavItem } from "@/components/tenant-app/app-shell";

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

  const t = await getTranslations("TenantApp.nav");
  const tAuth = await getTranslations("Auth");

  // Nav visibility only — never the authorization boundary itself. RLS is
  // what actually enforces access on every query these pages make; a
  // direct URL hit on a hidden route still resolves through the same
  // has_permission-gated policies, same as always.
  const [canViewStaff, canViewServices, canViewCustomers, canViewAppointments] = await Promise.all([
    hasPermission(access.tenant.id, "staff.view"),
    hasPermission(access.tenant.id, "services.view"),
    hasPermission(access.tenant.id, "customers.view"),
    hasPermission(access.tenant.id, "appointments.view"),
  ]);

  const navItems: TenantNavItem[] = [
    { href: "", label: t("dashboard"), icon: <LayoutDashboard className="size-4" /> },
    ...(canViewAppointments
      ? [{ href: "/appointments", label: t("appointments"), icon: <CalendarClock className="size-4" /> }]
      : []),
    ...(canViewCustomers
      ? [{ href: "/customers", label: t("customers"), icon: <Contact className="size-4" /> }]
      : []),
    ...(canViewStaff
      ? [{ href: "/staff", label: t("staff"), icon: <Users className="size-4" /> }]
      : []),
    ...(canViewServices
      ? [{ href: "/services", label: t("services"), icon: <Scissors className="size-4" /> }]
      : []),
  ];

  return (
    <TenantAppShell
      tenantSlug={tenantSlug}
      tenantName={access.tenant.name}
      roleName={access.roleName}
      userEmail={access.user.email ?? ""}
      navItems={navItems}
      signOutLabel={tAuth("signOut")}
    >
      {children}
    </TenantAppShell>
  );
}
