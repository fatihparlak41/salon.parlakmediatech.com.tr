import "server-only";
import { cache } from "react";
import type { User } from "@supabase/supabase-js";
import { createClient } from "@/lib/supabase/server";
import { authErrorLogFields, isStaleSessionError } from "@/lib/auth/session-errors";
// Plain next/navigation, not lib/i18n/navigation's Link — the server-side
// next-intl redirect() requires an explicit `locale` argument (it has no
// client-side "current locale" context to read), which is pure ceremony in
// a localePrefix:"never", single-locale setup. Client-rendered <Link>
// elements still use lib/i18n/navigation (see components/*).
import { redirect } from "next/navigation";

export type MembershipSummary = {
  tenantId: string;
  tenantSlug: string;
  tenantName: string;
  tenantStatus: string;
  roleId: string;
  roleName: string;
};

export type TenantAccessResult =
  | { reason: "unauthenticated" }
  | { reason: "not_found" }
  | {
      reason: "ok";
      user: User;
      tenant: { id: string; name: string; slug: string; status: string };
      roleName: string;
    };

/**
 * Never trust a client-supplied tenant_id or tenantSlug for authorization —
 * every function here re-derives access from the current session server
 * side. UI-level permission checks (hasPermission) are for showing/hiding
 * controls only; RLS is what actually enforces access on every query.
 *
 * Wrapped in React's cache() so a layout's guard check and a page's data
 * fetch in the same request share one DB round trip instead of two.
 */

export const getCurrentUser = cache(async (): Promise<User | null> => {
  const supabase = await createClient();
  try {
    const { data } = await supabase.auth.getUser();
    return data.user;
  } catch (error) {
    // getUser() has been observed to throw (rather than return {error})
    // for a stale/revoked refresh-token cookie — fail closed either way:
    // every caller here (requireUser, getTenantAccess, isPlatformAdmin)
    // already treats a null user as "not authenticated", so this is the
    // same safe outcome as the normal {data: {user: null}} path, just
    // reached from a catch instead. Only log if it's NOT that known case.
    if (!isStaleSessionError(error)) {
      console.error("[getCurrentUser] unexpected error", authErrorLogFields(error));
    }
    return null;
  }
});

export async function requireUser(): Promise<User> {
  const user = await getCurrentUser();
  if (!user) {
    redirect("/login");
  }
  return user;
}

/** All ACTIVE memberships for the current user, across every tenant. */
export const getUserMemberships = cache(
  async (): Promise<MembershipSummary[]> => {
    const user = await getCurrentUser();
    if (!user) return [];

    const supabase = await createClient();
    const { data, error } = await supabase
      .from("tenant_memberships")
      .select("tenant_id, role_id, tenants(name, slug, status), roles(name)")
      .eq("user_id", user.id)
      .eq("status", "active")
      .is("deleted_at", null);

    if (error || !data) return [];

    return data
      .filter((row) => row.tenants && row.roles)
      .map((row) => ({
        tenantId: row.tenant_id,
        tenantSlug: row.tenants!.slug,
        tenantName: row.tenants!.name,
        tenantStatus: row.tenants!.status,
        roleId: row.role_id,
        roleName: row.roles!.name,
      }));
  },
);

/**
 * Resolves tenantSlug -> tenant, then verifies the current user has an
 * active membership in it. This is the only place `/app/[tenantSlug]` may
 * trust a slug from. Distinguishes "not logged in" (-> redirect to /login)
 * from "logged in but not a member" (-> 404, never confirm the tenant
 * exists to someone unauthorized for it).
 */
export const getTenantAccess = cache(
  async (tenantSlug: string): Promise<TenantAccessResult> => {
    const user = await getCurrentUser();
    if (!user) return { reason: "unauthenticated" };

    const supabase = await createClient();

    const { data: tenant } = await supabase
      .from("tenants")
      .select("id, name, slug, status")
      .eq("slug", tenantSlug)
      .is("deleted_at", null)
      .maybeSingle();

    if (!tenant) return { reason: "not_found" };

    const { data: membership } = await supabase
      .from("tenant_memberships")
      .select("id, status, role_id, roles(name)")
      .eq("tenant_id", tenant.id)
      .eq("user_id", user.id)
      .eq("status", "active")
      .is("deleted_at", null)
      .maybeSingle();

    if (!membership || !membership.roles) return { reason: "not_found" };

    return { reason: "ok", user, tenant, roleName: membership.roles.name };
  },
);

/** Wraps the public.has_permission RPC (see architecture report section D). */
export async function hasPermission(
  tenantId: string,
  permissionKey: string,
): Promise<boolean> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("has_permission", {
    p_tenant_id: tenantId,
    p_permission_key: permissionKey,
  });
  if (error) return false;
  return data === true;
}

export const isPlatformAdmin = cache(async (): Promise<boolean> => {
  const user = await getCurrentUser();
  if (!user) return false;

  const supabase = await createClient();
  const { data, error } = await supabase.rpc("is_platform_admin");
  if (error) return false;
  return data === true;
});

export async function requirePlatformAdmin(): Promise<User> {
  const user = await requireUser();
  if (!(await isPlatformAdmin())) {
    redirect("/");
  }
  return user;
}
