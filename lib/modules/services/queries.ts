import "server-only";
import { createClient } from "@/lib/supabase/server";

export type ServiceListRow = {
  id: string;
  name: string;
  category: string | null;
  durationMinutes: number;
  price: string;
  status: string;
  branchNames: string[];
  eligibleStaffCount: number;
};

export async function getServiceList(tenantId: string): Promise<ServiceListRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(
      `id, name, category, duration_minutes, price, status,
       service_branches(branches(name)),
       staff_services(staff_member_id)`,
    )
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("display_order", { ascending: true })
    .order("name", { ascending: true });

  if (error || !data) return [];

  return data.map((row) => ({
    id: row.id,
    name: row.name,
    category: row.category,
    durationMinutes: row.duration_minutes,
    // Supabase/postgres returns numeric as a decimal string already — no
    // Number() round-trip on the way out of the DB.
    price: String(row.price),
    status: row.status,
    branchNames: row.service_branches.map((b) => b.branches?.name).filter((n): n is string => !!n),
    eligibleStaffCount: row.staff_services.length,
  }));
}

export type ServiceDetail = {
  id: string;
  name: string;
  category: string | null;
  description: string | null;
  durationMinutes: number;
  price: string;
  status: string;
  branchIds: string[];
  staffMemberIds: string[];
};

export async function getServiceDetail(serviceId: string): Promise<ServiceDetail | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("services")
    .select(
      `id, name, category, description, duration_minutes, price, status,
       service_branches(branch_id), staff_services(staff_member_id)`,
    )
    .eq("id", serviceId)
    .is("deleted_at", null)
    .maybeSingle();

  if (error || !data) return null;

  return {
    id: data.id,
    name: data.name,
    category: data.category,
    description: data.description,
    durationMinutes: data.duration_minutes,
    price: String(data.price),
    status: data.status,
    branchIds: data.service_branches.map((b) => b.branch_id),
    staffMemberIds: data.staff_services.map((s) => s.staff_member_id),
  };
}

/** Distinct existing category values — feeds a lightweight autocomplete so
 * categories stay consistent without a separate service_categories table
 * (services.category is a plain nullable text column; see 2B.1 inventory). */
export async function getExistingCategories(tenantId: string): Promise<string[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("services")
    .select("category")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .not("category", "is", null);

  return Array.from(new Set((data ?? []).map((r) => r.category!).filter(Boolean))).sort();
}

export type StaffOption = { id: string; fullName: string; status: string };

export async function getStaffOptions(tenantId: string): Promise<StaffOption[]> {
  const supabase = await createClient();
  const { data } = await supabase
    .from("staff_members")
    .select("id, full_name, status")
    .eq("tenant_id", tenantId)
    .is("deleted_at", null)
    .order("full_name", { ascending: true });

  return (data ?? []).map((s) => ({ id: s.id, fullName: s.full_name, status: s.status }));
}
