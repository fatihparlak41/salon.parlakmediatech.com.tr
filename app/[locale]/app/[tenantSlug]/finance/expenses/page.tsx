import { redirect } from "next/navigation";
import { getMessages } from "next-intl/server";
import { getTenantAccess, hasPermission } from "@/lib/auth/session";
import { getBranchOptions } from "@/lib/modules/staff/queries";
import {
  getExpenseCategories,
  getExpenseOverview,
  getExpensesFirstPage,
} from "@/lib/modules/expenses/queries";
import {
  listParamsFor,
  parseExpensesFilters,
} from "@/lib/modules/expenses/filters";
import type { ExpenseLabels } from "@/lib/modules/expenses/labels";
import { ExpensesErrorState } from "@/components/expenses/expenses-error-state";
import { ExpensesPageClient } from "@/components/expenses/expenses-page-client";

/**
 * Faz FIN.1B.1 — Giderler. A Server Component: resolves access and the URL filters, reads through the narrow finance.view-gated
 * RPCs with the caller's own session (never a table, never the service role), and hands everything to the client for the first
 * paint. Without finance.view it redirects: content is never rendered and hidden client-side. A failed read renders an
 * explicit error state with a retry, never a blank page. finance.manage only decides whether the mutating controls exist; the
 * RPCs enforce it again.
 */
export default async function ExpensesPage({
  params,
  searchParams,
}: PageProps<"/[locale]/app/[tenantSlug]/finance/expenses">) {
  const { tenantSlug } = await params;
  const access = await getTenantAccess(tenantSlug);
  if (access.reason !== "ok") return null;

  const [canView, canManage] = await Promise.all([
    hasPermission(access.tenant.id, "finance.view"),
    hasPermission(access.tenant.id, "finance.manage"),
  ]);
  // The nav hides the entry without finance.view; a direct hit is bounced, like every other tenant-app page.
  if (!canView) {
    redirect(`/app/${tenantSlug}`);
  }

  const filters = parseExpensesFilters(
    (await searchParams) as Record<string, string | string[] | undefined>,
  );
  const labels = (await getMessages()).Expenses as unknown as ExpenseLabels;

  const tenantId = access.tenant.id;
  const [categoriesResult, branches, overviewResult] = await Promise.all([
    getExpenseCategories(tenantId),
    getBranchOptions(tenantId),
    getExpenseOverview(tenantId, {
      month: filters.month ? `${filters.month}-01` : null,
      branchId:
        filters.branch !== "all" && filters.branch !== "general"
          ? filters.branch
          : null,
      generalOnly: filters.branch === "general",
    }),
  ]);
  if (!categoriesResult.ok || !overviewResult.ok) {
    return <ExpensesErrorState labels={labels} />;
  }

  // The list needs the month the overview actually used (the URL's, or the database's default for the tenant-local date) and
  // its reference date, so the cards and the rows agree on "this month" and on what is overdue.
  const overview = overviewResult.data;
  const listParams = listParamsFor(filters, overview.month.slice(0, 7));
  const firstPageResult = await getExpensesFirstPage(
    tenantId,
    listParams,
    overview.referenceDate,
  );
  if (!firstPageResult.ok) {
    return <ExpensesErrorState labels={labels} />;
  }

  return (
    <ExpensesPageClient
      tenantId={tenantId}
      tenantSlug={tenantSlug}
      canManage={canManage}
      categories={categoriesResult.data}
      branches={branches.map((b) => ({ id: b.id, name: b.name }))}
      overview={overview}
      firstPage={firstPageResult.data}
      filters={filters}
      listParams={listParams}
      labels={labels}
    />
  );
}
