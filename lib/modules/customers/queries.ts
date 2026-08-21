import "server-only";
import { createClient } from "@/lib/supabase/server";
import { CUSTOMERS_PAGE_SIZE } from "./constants";

export type CustomerRow = {
  id: string;
  fullName: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: string;
  createdAt: string;
};

function mapRow(r: {
  id: string;
  full_name: string;
  phone: string | null;
  email: string | null;
  notes: string | null;
  status: string;
  created_at: string;
}): CustomerRow {
  return {
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
  };
}

/** First page only — the client takes over via the same search_customers
 * RPC (browser client) for search input and "load more", so there is
 * exactly one query shape for "browse" and "search" alike. Thousands of
 * customers per salon means this must never become "fetch everything,
 * filter in the browser". */
export async function getInitialCustomers(
  tenantId: string,
  status: "active" | "archived" = "active",
): Promise<CustomerRow[]> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("search_customers", {
    p_tenant_id: tenantId,
    p_query: "",
    p_status: status,
    p_limit: CUSTOMERS_PAGE_SIZE,
    p_offset: 0,
  });
  if (error || !data) return [];
  return data.map(mapRow);
}

export async function getCustomerCounts(tenantId: string): Promise<{ active: number; archived: number }> {
  const supabase = await createClient();
  const [activeRes, archivedRes] = await Promise.all([
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "active").is("deleted_at", null),
    supabase.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "archived").is("deleted_at", null),
  ]);
  return { active: activeRes.count ?? 0, archived: archivedRes.count ?? 0 };
}

export async function getCustomerDetail(customerId: string): Promise<CustomerRow | null> {
  const supabase = await createClient();
  const { data, error } = await supabase
    .from("customers")
    .select("id, full_name, phone, email, notes, status, created_at")
    .eq("id", customerId)
    .is("deleted_at", null)
    .maybeSingle();
  if (error || !data) return null;
  return mapRow(data);
}
