/**
 * Faz FIN.1B.1 — client mirror of the expense read models, called straight from the browser (pure reads: nothing to gate
 * behind requireUser or revalidatePath). Used for the keyset "Daha fazla" pages of the list and for the detail sheet, which
 * fetches get_expense when it opens. The RPCs themselves are the authority: finance.view required, curated PII-free jsonb.
 * A failure comes back as { ok: false, code } so the caller can show the expense error message with a retry.
 */
import { createClient } from "@/lib/supabase/client";
import { listRpcArgs, type ExpenseListParams } from "./filters";
import type {
  ExpenseCursor,
  ExpenseDetail,
  ExpenseListPage,
  ExpenseReadResult,
} from "./types";

export async function fetchExpensesPage(
  tenantId: string,
  params: ExpenseListParams,
  cursor: ExpenseCursor | null,
  referenceDate: string,
): Promise<ExpenseReadResult<ExpenseListPage>> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc(
    "list_expenses",
    listRpcArgs(tenantId, params, cursor, referenceDate),
  );
  if (error || !data) return { ok: false, code: error?.code ?? null };
  return { ok: true, data: data as unknown as ExpenseListPage };
}

export async function fetchExpenseDetail(
  expenseId: string,
  referenceDate: string,
): Promise<ExpenseReadResult<ExpenseDetail>> {
  const supabase = createClient();
  const { data, error } = await supabase.rpc("get_expense", {
    p_expense_id: expenseId,
    p_reference_date: referenceDate,
  });
  if (error || !data) return { ok: false, code: error?.code ?? null };
  return { ok: true, data: data as unknown as ExpenseDetail };
}
