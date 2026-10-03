import { createClient } from "@/lib/supabase/server";
import { listRpcArgs, type ExpenseListParams } from "./filters";
import type {
  ExpenseCategory,
  ExpenseListPage,
  ExpenseOverview,
  ExpenseReadResult,
} from "./types";

/**
 * Faz FIN.1B.1 — server-side reads for the expense page. Every read goes through the narrow, finance.view-gated RPCs through
 * the caller's own session (never the service role, never a table): the database is the authority, and a failure comes back
 * as { ok: false, code } so the page can render an explicit error state with a retry instead of a blank screen.
 */

function failed<T>(
  error: { code?: string | null } | null,
): ExpenseReadResult<T> {
  return { ok: false, code: error?.code ?? null };
}

export async function getExpenseCategories(
  tenantId: string,
): Promise<ExpenseReadResult<ExpenseCategory[]>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("list_expense_categories", {
    p_tenant_id: tenantId,
  });
  if (error || !data) return failed(error);
  return { ok: true, data: data as unknown as ExpenseCategory[] };
}

export type ExpenseOverviewScope = {
  /** First day of the month, YYYY-MM-DD; omit for the month of the tenant-local reference date. */
  month?: string | null;
  branchId?: string | null;
  generalOnly?: boolean;
};

export async function getExpenseOverview(
  tenantId: string,
  scope: ExpenseOverviewScope = {},
): Promise<ExpenseReadResult<ExpenseOverview>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc("get_expense_overview", {
    p_tenant_id: tenantId,
    p_month: scope.month ?? undefined,
    p_branch_id: scope.branchId ?? undefined,
    p_general_only: scope.generalOnly ?? false,
  });
  if (error || !data) return failed(error);
  return { ok: true, data: data as unknown as ExpenseOverview };
}

export async function getExpensesFirstPage(
  tenantId: string,
  params: ExpenseListParams,
  referenceDate: string,
): Promise<ExpenseReadResult<ExpenseListPage>> {
  const supabase = await createClient();
  const { data, error } = await supabase.rpc(
    "list_expenses",
    listRpcArgs(tenantId, params, null, referenceDate),
  );
  if (error || !data) return failed(error);
  return { ok: true, data: data as unknown as ExpenseListPage };
}
