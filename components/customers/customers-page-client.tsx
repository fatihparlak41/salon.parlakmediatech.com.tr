"use client";

import { useEffect, useRef, useState } from "react";
import { Plus, Search, Contact } from "lucide-react";
import { createClient } from "@/lib/supabase/client";
import type { CustomerRow } from "@/lib/modules/customers/queries";
import { CUSTOMERS_PAGE_SIZE } from "@/lib/modules/customers/constants";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { CustomerList } from "@/components/customers/customer-list";
import { CreateCustomerDialog } from "@/components/customers/create-customer-dialog";
import { CustomerDetailSheet } from "@/components/customers/customer-detail-sheet";

type Labels = {
  title: string;
  description: string;
  addCustomer: string;
  searchPlaceholder: string;
  emptyTitle: string;
  emptyDescription: string;
  emptyCta: string;
  noResults: string;
  activeCountLabel: string;
  archivedCountLabel: string;
  loadMore: string;
  filterActive: string;
  filterArchived: string;
};

async function fetchCustomers(
  tenantId: string,
  query: string,
  status: "active" | "archived",
  offset: number,
): Promise<CustomerRow[]> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("search_customers", {
    p_tenant_id: tenantId,
    p_query: query,
    p_status: status,
    p_limit: CUSTOMERS_PAGE_SIZE,
    p_offset: offset,
  });
  if (error || !data) return [];
  return data.map((r) => ({
    id: r.id,
    fullName: r.full_name,
    phone: r.phone,
    email: r.email,
    notes: r.notes,
    status: r.status,
    createdAt: r.created_at,
  }));
}

export function CustomersPageClient({
  tenantId,
  tenantSlug,
  canManage,
  initialCustomers,
  initialCounts,
  labels,
}: {
  tenantId: string;
  tenantSlug: string;
  canManage: boolean;
  initialCustomers: CustomerRow[];
  initialCounts: { active: number; archived: number };
  labels: Labels;
}) {
  const [search, setSearch] = useState("");
  const [statusFilter, setStatusFilter] = useState<"active" | "archived">("active");
  const [customers, setCustomers] = useState(initialCustomers);
  const [counts, setCounts] = useState(initialCounts);
  const [loading, setLoading] = useState(false);
  const [hasMore, setHasMore] = useState(initialCustomers.length === CUSTOMERS_PAGE_SIZE);
  const [createOpen, setCreateOpen] = useState(false);
  const [selectedCustomerId, setSelectedCustomerId] = useState<string | null>(null);

  const isFirstRun = useRef(true);

  // Debounced server-side search/filter — never "fetch everything, filter
  // in the browser". Skips the redundant refetch on mount since the
  // server component already provided page 1 of the default (active, no
  // query) view.
  useEffect(() => {
    if (isFirstRun.current) {
      isFirstRun.current = false;
      return;
    }
    const handle = setTimeout(async () => {
      setLoading(true);
      const results = await fetchCustomers(tenantId, search, statusFilter, 0);
      setCustomers(results);
      setHasMore(results.length === CUSTOMERS_PAGE_SIZE);
      setLoading(false);
    }, 300);
    return () => clearTimeout(handle);
  }, [search, statusFilter, tenantId]);

  async function loadMore() {
    setLoading(true);
    const results = await fetchCustomers(tenantId, search, statusFilter, customers.length);
    setCustomers((prev) => [...prev, ...results]);
    setHasMore(results.length === CUSTOMERS_PAGE_SIZE);
    setLoading(false);
  }

  async function refreshCounts() {
    const supabase = createClient();
    const [activeRes, archivedRes] = await Promise.all([
      supabase.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "active").is("deleted_at", null),
      supabase.from("customers").select("id", { count: "exact", head: true }).eq("tenant_id", tenantId).eq("status", "archived").is("deleted_at", null),
    ]);
    setCounts({ active: activeRes.count ?? 0, archived: archivedRes.count ?? 0 });
  }

  async function refreshList() {
    const results = await fetchCustomers(tenantId, search, statusFilter, 0);
    setCustomers(results);
    setHasMore(results.length === CUSTOMERS_PAGE_SIZE);
    await refreshCounts();
  }

  const isEmptyOverall = counts.active === 0 && counts.archived === 0;

  return (
    <div className="mx-auto w-full max-w-4xl px-4 py-8 sm:px-6 sm:py-10">
      <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">{labels.title}</h1>
          <p className="text-muted-foreground mt-1 text-sm">{labels.description}</p>
        </div>
        {canManage && !isEmptyOverall && (
          <Button onClick={() => setCreateOpen(true)} className="shrink-0">
            <Plus />
            {labels.addCustomer}
          </Button>
        )}
      </div>

      {!isEmptyOverall && (
        <>
          <div className="mt-6 flex items-center gap-4 text-sm">
            <span className="text-foreground font-medium">
              {labels.activeCountLabel}: {counts.active}
            </span>
            <span className="text-muted-foreground">
              {labels.archivedCountLabel}: {counts.archived}
            </span>
          </div>

          <div className="mt-4 flex flex-col gap-3 sm:flex-row sm:items-center">
            <div className="relative flex-1">
              <Search className="text-muted-foreground pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2" />
              <Input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder={labels.searchPlaceholder}
                className="pl-9"
              />
            </div>
            <Tabs value={statusFilter} onValueChange={(v) => setStatusFilter(v as "active" | "archived")}>
              <TabsList>
                <TabsTrigger value="active">{labels.filterActive}</TabsTrigger>
                <TabsTrigger value="archived">{labels.filterArchived}</TabsTrigger>
              </TabsList>
            </Tabs>
          </div>
        </>
      )}

      <div className="mt-4">
        {isEmptyOverall ? (
          <div className="border-border flex flex-col items-center gap-3 rounded-xl border border-dashed px-6 py-16 text-center">
            <div className="bg-muted flex size-12 items-center justify-center rounded-full">
              <Contact className="text-muted-foreground size-6" />
            </div>
            <h2 className="text-base font-medium">{labels.emptyTitle}</h2>
            <p className="text-muted-foreground max-w-sm text-sm">{labels.emptyDescription}</p>
            {canManage && (
              <Button onClick={() => setCreateOpen(true)} className="mt-2">
                <Plus />
                {labels.emptyCta}
              </Button>
            )}
          </div>
        ) : customers.length === 0 && !loading ? (
          <p className="text-muted-foreground py-10 text-center text-sm">{labels.noResults}</p>
        ) : (
          <>
            <CustomerList items={customers} onSelect={(id) => setSelectedCustomerId(id)} />
            {hasMore && (
              <div className="mt-4 flex justify-center">
                <Button variant="outline" onClick={loadMore} disabled={loading}>
                  {loading ? "…" : labels.loadMore}
                </Button>
              </div>
            )}
          </>
        )}
      </div>

      {canManage && (
        <CreateCustomerDialog
          open={createOpen}
          onOpenChange={setCreateOpen}
          tenantId={tenantId}
          tenantSlug={tenantSlug}
          onCreated={async (id) => {
            setCreateOpen(false);
            await refreshList();
            setSelectedCustomerId(id);
          }}
        />
      )}

      <CustomerDetailSheet
        customerId={selectedCustomerId}
        onOpenChange={(open) => {
          if (!open) setSelectedCustomerId(null);
        }}
        tenantSlug={tenantSlug}
        canManage={canManage}
        onSaved={refreshList}
      />
    </div>
  );
}
