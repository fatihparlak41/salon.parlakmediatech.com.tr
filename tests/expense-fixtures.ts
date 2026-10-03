/**
 * Faz FIN.1B.1 — shared fixtures for the expense DB test files. Not a test file (vitest only collects *.test.ts[x]).
 *
 * Everything goes through the real public.* RPC surface as a real tenant member, in ONE transaction per call with the
 * role `authenticated` and the JWT claims set — exactly what a PostgREST request would see — so no test spends a
 * rate-limited password sign-in. Assertions about row state read ground truth through testDb.
 */
import { randomUUID } from "node:crypto";
import {
  testDb,
  createTestUser,
  createTestTenant,
  createBranch,
  createCustomRole,
  createTestMembershipFromTemplate,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  asAuthenticatedUser,
  type TestUser,
} from "./helpers";

export type RpcOutcome<T = Record<string, unknown>> =
  | { ok: true; data: T }
  | { ok: false; code: string | undefined; message: string };

/** [argument name, value, postgres type]. A value of `undefined` OMITS the argument (so its SQL default applies);
 * `null` passes SQL NULL explicitly. */
export type RpcArg = readonly [name: string, value: unknown, pgType: string];

export function buildCall(
  fn: string,
  args: RpcArg[],
): { query: string; params: unknown[] } {
  const present = args.filter(([, value]) => value !== undefined);
  // postgres.js converts a value bound to a timestamptz placeholder through a JS Date, which drops microseconds. Binding the
  // text and casting in SQL keeps the exact instant the test wrote.
  const cast = (type: string) =>
    type === "timestamptz" ? "text::timestamptz" : type;
  const named = present
    .map(([name, , type], i) => `${name} := $${i + 1}::${cast(type)}`)
    .join(", ");
  return {
    query: `select public.${fn}(${named}) as r`,
    params: present.map(([, value]) => value),
  };
}

export function toOutcome<T>(error: unknown): RpcOutcome<T> {
  const e = error as { code?: string; message?: string };
  return { ok: false, code: e.code, message: e.message ?? String(error) };
}

/** Calls public.<fn> as `userId` (role authenticated, JWT sub = userId). */
export async function callRpc<T = Record<string, unknown>>(
  userId: string,
  fn: string,
  args: RpcArg[],
): Promise<RpcOutcome<T>> {
  const { query, params } = buildCall(fn, args);
  try {
    const rows = await asAuthenticatedUser(userId, (sql) =>
      sql.unsafe(query, params as never[]),
    );
    return { ok: true, data: (rows[0] as unknown as { r: T }).r };
  } catch (error) {
    return toOutcome<T>(error);
  }
}

/** Role `authenticated` but NO JWT claims: auth.uid() is null (what an expired or missing session looks like). */
export async function callRpcNoJwt<T = Record<string, unknown>>(
  fn: string,
  args: RpcArg[],
): Promise<RpcOutcome<T>> {
  const { query, params } = buildCall(fn, args);
  try {
    const rows = await testDb.begin(async (sql) => {
      await sql`set local role authenticated`;
      return sql.unsafe(query, params as never[]);
    });
    return { ok: true, data: (rows[0] as unknown as { r: T }).r };
  } catch (error) {
    return toOutcome<T>(error);
  }
}

/** Role `anon`: EXECUTE on every expense wrapper must be denied (42501). */
export async function callRpcAsAnon<T = Record<string, unknown>>(
  fn: string,
  args: RpcArg[],
): Promise<RpcOutcome<T>> {
  const { query, params } = buildCall(fn, args);
  try {
    const rows = await testDb.begin(async (sql) => {
      await sql`set local role anon`;
      return sql.unsafe(query, params as never[]);
    });
    return { ok: true, data: (rows[0] as unknown as { r: T }).r };
  } catch (error) {
    return toOutcome<T>(error);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------------------------------------------

export type InitialPayment = {
  amount: number | string;
  method: string;
  paid_at: string;
  note?: string | null;
};

export type CreateExpenseInput = {
  tenantId: string | null;
  categoryKey: string | null;
  description: string | null;
  expenseDate: string | null;
  amount: number | string | null;
  /** undefined omits the argument; null sends SQL NULL. */
  idempotencyKey?: string | null;
  branchId?: string | null;
  vendorName?: string | null;
  dueDate?: string | null;
  note?: string | null;
  initialPayment?:
    InitialPayment | Record<string, unknown> | unknown[] | string | null;
};

export type ExpenseWriteResult = {
  expenseId: string;
  paymentId?: string | null;
  status: string;
  version: number;
  noop: boolean;
};

export function createArgs(i: CreateExpenseInput): RpcArg[] {
  return [
    ["p_tenant_id", i.tenantId, "uuid"],
    ["p_category_key", i.categoryKey, "text"],
    ["p_description", i.description, "text"],
    ["p_expense_date", i.expenseDate, "date"],
    ["p_amount", i.amount, "numeric"],
    ["p_idempotency_key", i.idempotencyKey, "uuid"],
    ["p_branch_id", i.branchId, "uuid"],
    ["p_vendor_name", i.vendorName, "text"],
    ["p_due_date", i.dueDate, "date"],
    ["p_note", i.note, "text"],
    ["p_initial_payment", i.initialPayment, "jsonb"],
  ];
}

export function createExpense(userId: string, i: CreateExpenseInput) {
  return callRpc<ExpenseWriteResult>(userId, "create_expense", createArgs(i));
}

export type UpdateExpenseInput = {
  expenseId: string | null;
  categoryKey: string | null;
  description: string | null;
  expenseDate: string | null;
  amount: number | string | null;
  expectedVersion?: number | null;
  branchId?: string | null;
  vendorName?: string | null;
  dueDate?: string | null;
  note?: string | null;
};

export function updateArgs(i: UpdateExpenseInput): RpcArg[] {
  return [
    ["p_expense_id", i.expenseId, "uuid"],
    ["p_category_key", i.categoryKey, "text"],
    ["p_description", i.description, "text"],
    ["p_expense_date", i.expenseDate, "date"],
    ["p_amount", i.amount, "numeric"],
    ["p_expected_version", i.expectedVersion, "integer"],
    ["p_branch_id", i.branchId, "uuid"],
    ["p_vendor_name", i.vendorName, "text"],
    ["p_due_date", i.dueDate, "date"],
    ["p_note", i.note, "text"],
  ];
}

export function updateExpense(userId: string, i: UpdateExpenseInput) {
  return callRpc<ExpenseWriteResult>(userId, "update_expense", updateArgs(i));
}

export function cancelArgs(
  expenseId: string | null,
  reason: string | null,
): RpcArg[] {
  return [
    ["p_expense_id", expenseId, "uuid"],
    ["p_reason", reason, "text"],
  ];
}

export function cancelExpense(
  userId: string,
  expenseId: string | null,
  reason: string | null,
) {
  return callRpc<ExpenseWriteResult>(
    userId,
    "cancel_expense",
    cancelArgs(expenseId, reason),
  );
}

export type RecordPaymentInput = {
  expenseId: string | null;
  amount: number | string | null;
  method: string | null;
  paidAt: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
};

export function recordArgs(i: RecordPaymentInput): RpcArg[] {
  return [
    ["p_expense_id", i.expenseId, "uuid"],
    ["p_amount", i.amount, "numeric"],
    ["p_method", i.method, "text"],
    ["p_paid_at", i.paidAt, "timestamptz"],
    ["p_note", i.note, "text"],
    ["p_idempotency_key", i.idempotencyKey, "uuid"],
  ];
}

export function recordPayment(userId: string, i: RecordPaymentInput) {
  return callRpc<ExpenseWriteResult>(
    userId,
    "record_expense_payment",
    recordArgs(i),
  );
}

export function voidArgs(
  paymentId: string | null,
  reason: string | null,
): RpcArg[] {
  return [
    ["p_payment_id", paymentId, "uuid"],
    ["p_reason", reason, "text"],
  ];
}

export function voidPayment(
  userId: string,
  paymentId: string | null,
  reason: string | null,
) {
  return callRpc<ExpenseWriteResult>(
    userId,
    "void_expense_payment",
    voidArgs(paymentId, reason),
  );
}

export type ListExpensesInput = {
  tenantId: string | null;
  fromDate?: string | null;
  toDate?: string | null;
  branchId?: string | null;
  generalOnly?: boolean;
  categoryKey?: string | null;
  status?: string | null;
  includeCancelled?: boolean;
  overdueOnly?: boolean;
  search?: string | null;
  limit?: number | null;
  cursorDate?: string | null;
  cursorId?: string | null;
  referenceDate?: string | null;
};

export type ExpenseListItem = Record<string, unknown> & {
  id: string;
  expenseDate: string;
  status: string;
};
export type ExpenseListResult = {
  items: ExpenseListItem[];
  nextCursor: { expenseDate: string; id: string } | null;
};

export function listExpenses(userId: string, i: ListExpensesInput) {
  return callRpc<ExpenseListResult>(userId, "list_expenses", [
    ["p_tenant_id", i.tenantId, "uuid"],
    ["p_from_date", i.fromDate, "date"],
    ["p_to_date", i.toDate, "date"],
    ["p_branch_id", i.branchId, "uuid"],
    ["p_general_only", i.generalOnly, "boolean"],
    ["p_category_key", i.categoryKey, "text"],
    ["p_status", i.status, "text"],
    ["p_include_cancelled", i.includeCancelled, "boolean"],
    ["p_overdue_only", i.overdueOnly, "boolean"],
    ["p_search", i.search, "text"],
    ["p_limit", i.limit, "integer"],
    ["p_cursor_date", i.cursorDate, "date"],
    ["p_cursor_id", i.cursorId, "uuid"],
    ["p_reference_date", i.referenceDate, "date"],
  ]);
}

export type ExpensePaymentView = {
  id: string;
  amount: number;
  method: string;
  paidAt: string;
  note: string | null;
  status: string;
  voidReason: string | null;
};
export type ExpenseDetail = Record<string, unknown> & {
  id: string;
  status: string;
  version: number;
  amount: number;
  paid: number;
  outstanding: number;
  payments: ExpensePaymentView[];
};

export function getExpense(
  userId: string,
  expenseId: string | null,
  referenceDate?: string | null,
) {
  return callRpc<ExpenseDetail>(userId, "get_expense", [
    ["p_expense_id", expenseId, "uuid"],
    ["p_reference_date", referenceDate, "date"],
  ]);
}

export type OverviewCurrency = {
  currency: string;
  incurred: number;
  paid: number;
  outstanding: { total: number; count: number };
  overdue: { total: number; count: number };
  upcoming: { total: number; count: number; withinDays: number };
};
export type ExpenseOverview = {
  month: string;
  referenceDate: string;
  primaryCurrency: string;
  byCurrency: OverviewCurrency[];
};

export function getOverview(
  userId: string,
  tenantId: string | null,
  o: {
    month?: string | null;
    branchId?: string | null;
    generalOnly?: boolean;
    referenceDate?: string | null;
  } = {},
) {
  return callRpc<ExpenseOverview>(userId, "get_expense_overview", [
    ["p_tenant_id", tenantId, "uuid"],
    ["p_month", o.month, "date"],
    ["p_branch_id", o.branchId, "uuid"],
    ["p_general_only", o.generalOnly, "boolean"],
    ["p_reference_date", o.referenceDate, "date"],
  ]);
}

export function listCategories(userId: string, tenantId: string | null) {
  return callRpc<{ key: string; kind: string; displayOrder: number }[]>(
    userId,
    "list_expense_categories",
    [["p_tenant_id", tenantId, "uuid"]],
  );
}

/** Every public wrapper, with a valid-looking argument set, for permission/anon matrices. */
export const EXPENSE_WRAPPERS = [
  "list_expense_categories",
  "get_expense_overview",
  "list_expenses",
  "get_expense",
  "create_expense",
  "update_expense",
  "cancel_expense",
  "record_expense_payment",
  "void_expense_payment",
] as const;

// ---------------------------------------------------------------------------------------------------------------
// The world: one tenant with every kind of caller, plus a second tenant
// ---------------------------------------------------------------------------------------------------------------

export type ExpenseWorld = {
  tenant: { id: string; slug: string };
  otherTenant: { id: string; slug: string };
  branchId: string;
  branch2Id: string;
  otherBranchId: string;
  deletedBranchId: string;
  owner: TestUser; // SALON_OWNER: finance.view + finance.manage
  viewOnly: TestUser; // custom role: finance.view
  manageOnly: TestUser; // custom role: finance.manage
  neither: TestUser; // custom role: appointments.view only ("ordinary staff")
  manager: TestUser; // default Yönetici (SALON_MANAGER template)
  receptionist: TestUser; // default Resepsiyon
  stylist: TestUser; // default Personel
  stranger: TestUser; // authenticated user with no membership in the tenant
  otherOwner: TestUser; // owner of the second tenant
  accountant: TestUser; // ACCOUNTANT template (finance.view + finance.manage), a second finance.manage holder
  roles: { viewOnly: string; manageOnly: string; neither: string };
  users: TestUser[];
};

export async function createExpenseWorld(label: string): Promise<ExpenseWorld> {
  const short = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mk = (n: string) => createTestUser(`${label}-${n}`);
  const [
    owner,
    viewOnly,
    manageOnly,
    neither,
    manager,
    receptionist,
    stylist,
    stranger,
    otherOwner,
    accountant,
  ] = await Promise.all(
    [
      "owner",
      "view",
      "manage",
      "neither",
      "mgr",
      "recep",
      "stylist",
      "stranger",
      "other",
      "acct",
    ].map(mk),
  );
  const tenantRow = await createTestTenant(`test-${label}-${short}`, owner!.id);
  const otherRow = await createTestTenant(
    `test-${label}-o${short}`,
    otherOwner!.id,
  );
  const tenant = { id: tenantRow.id, slug: tenantRow.slug };
  const otherTenant = { id: otherRow.id, slug: otherRow.slug };

  const branchId = await createBranch(tenant.id, "Gider Şube");
  const branch2Id = await createBranch(tenant.id, "Gider Şube 2");
  const otherBranchId = await createBranch(
    otherTenant.id,
    "Başka Salon Şubesi",
  );
  const deletedBranchId = await createBranch(tenant.id, "Silinmiş Şube");
  await testDb`update branches set deleted_at = now() where id = ${deletedBranchId}`;

  const viewRole = await createCustomRole(tenant.id, "FIN Sadece Görüntüle", [
    "finance.view",
  ]);
  const manageRole = await createCustomRole(tenant.id, "FIN Sadece Yönet", [
    "finance.manage",
  ]);
  const neitherRole = await createCustomRole(
    tenant.id,
    "FIN Sıradan Personel",
    ["appointments.view"],
  );
  await addMembership(tenant.id, viewOnly!.id, viewRole);
  await addMembership(tenant.id, manageOnly!.id, manageRole);
  await addMembership(tenant.id, neither!.id, neitherRole);
  await createTestMembershipFromTemplate(
    tenant.id,
    manager!.id,
    "SALON_MANAGER",
  );
  await createTestMembershipFromTemplate(
    tenant.id,
    receptionist!.id,
    "RECEPTIONIST",
  );
  await createTestMembershipFromTemplate(tenant.id, stylist!.id, "STYLIST");
  await createTestMembershipFromTemplate(
    tenant.id,
    accountant!.id,
    "ACCOUNTANT",
  );

  const users = [
    owner!,
    viewOnly!,
    manageOnly!,
    neither!,
    manager!,
    receptionist!,
    stylist!,
    stranger!,
    otherOwner!,
    accountant!,
  ];
  return {
    tenant,
    otherTenant,
    branchId,
    branch2Id,
    otherBranchId,
    deletedBranchId,
    owner: owner!,
    viewOnly: viewOnly!,
    manageOnly: manageOnly!,
    neither: neither!,
    manager: manager!,
    receptionist: receptionist!,
    stylist: stylist!,
    stranger: stranger!,
    otherOwner: otherOwner!,
    accountant: accountant!,
    roles: { viewOnly: viewRole, manageOnly: manageRole, neither: neitherRole },
    users,
  };
}

export async function destroyExpenseWorld(
  world: ExpenseWorld | undefined,
): Promise<void> {
  if (!world) return;
  await cleanupTenants([world.tenant.id, world.otherTenant.id]);
  await cleanupUsers(world.users.map((u) => u.id));
}

// ---------------------------------------------------------------------------------------------------------------
// Builders and ground-truth readers
// ---------------------------------------------------------------------------------------------------------------

export const newKey = () => randomUUID();

/** An instant `minutesAgo` minutes in the past, as an ISO string (millisecond precision, like a browser). */
export function instantAgo(minutesAgo: number): string {
  return new Date(Date.now() - minutesAgo * 60_000).toISOString();
}

export function instantAhead(minutesAhead: number): string {
  return new Date(Date.now() + minutesAhead * 60_000).toISOString();
}

export function ip(
  amount: number | string,
  method = "cash",
  paidAt = instantAgo(5),
  note?: string | null,
): InitialPayment {
  const out: InitialPayment = { amount, method, paid_at: paidAt };
  if (note !== undefined) out.note = note;
  return out;
}

let seq = 0;
export function uniqueText(prefix: string): string {
  seq += 1;
  return `${prefix} ${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A valid create payload with sensible defaults; override what the test is about. */
export function validCreate(
  world: ExpenseWorld,
  o: Partial<CreateExpenseInput> = {},
): CreateExpenseInput {
  return {
    tenantId: world.tenant.id,
    categoryKey: "supplies",
    description: uniqueText("Test gideri"),
    expenseDate: "2026-10-01",
    amount: 1000,
    idempotencyKey: newKey(),
    ...o,
  };
}

/** Create through the RPC as the owner; throws if it fails (fixture code, not an assertion). */
export async function makeExpense(
  world: ExpenseWorld,
  o: Partial<CreateExpenseInput> = {},
  as: TestUser = world.owner,
) {
  const out = await createExpense(as.id, validCreate(world, o));
  if (!out.ok)
    throw new Error(
      `fixture create_expense failed: ${out.code} ${out.message}`,
    );
  return out.data;
}

export async function makePayment(
  world: ExpenseWorld,
  expenseId: string,
  amount: number,
  o: Partial<RecordPaymentInput> = {},
  as: TestUser = world.owner,
) {
  const out = await recordPayment(as.id, {
    expenseId,
    amount,
    method: "cash",
    paidAt: instantAgo(5),
    idempotencyKey: newKey(),
    ...o,
  });
  if (!out.ok)
    throw new Error(
      `fixture record_expense_payment failed: ${out.code} ${out.message}`,
    );
  return out.data;
}

export type ExpenseRow = {
  id: string;
  tenant_id: string;
  branch_id: string | null;
  category_key: string;
  description: string;
  vendor_name: string | null;
  note: string | null;
  expense_date: string;
  due_date: string | null;
  amount: string;
  currency: string;
  status: string;
  version: number;
  settlement_events: number;
  idempotency_key: string | null;
  idempotency_fingerprint: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function expenseRow(id: string): Promise<ExpenseRow> {
  const [row] = await testDb<ExpenseRow[]>`
    select id, tenant_id, branch_id, category_key, description, vendor_name, note,
           to_char(expense_date, 'YYYY-MM-DD') as expense_date, to_char(due_date, 'YYYY-MM-DD') as due_date,
           amount::text as amount, currency, status, version, settlement_events, idempotency_key,
           idempotency_fingerprint, cancelled_at, cancelled_by, cancel_reason, created_by, created_at, updated_at
    from expenses where id = ${id}`;
  if (!row) throw new Error(`expense ${id} not found`);
  return row;
}

export type PaymentRow = {
  id: string;
  expense_id: string;
  amount: string;
  method: string;
  paid_at: Date;
  note: string | null;
  status: string;
  idempotency_key: string;
  voided_at: Date | null;
  void_reason: string | null;
};

export async function paymentRows(expenseId: string): Promise<PaymentRow[]> {
  return testDb<PaymentRow[]>`
    select id, expense_id, amount::text as amount, method, paid_at, note, status, idempotency_key, voided_at, void_reason
    from expense_payments where expense_id = ${expenseId} order by created_at, id`;
}

export async function postedTotal(expenseId: string): Promise<number> {
  const [row] = await testDb<
    { t: string }[]
  >`select coalesce(sum(amount), 0)::text as t from expense_payments where expense_id = ${expenseId} and status = 'posted'`;
  return Number(row!.t);
}

const FINANCE_EXPENSE_ACTIONS = [
  "finance.expense_created",
  "finance.expense_updated",
  "finance.expense_cancelled",
  "finance.expense_payment_recorded",
  "finance.expense_payment_voided",
];

export type AuditRow = {
  id: string;
  action: string;
  entity_type: string;
  entity_id: string | null;
  actor_user_id: string | null;
  actor_type: string;
  before: Record<string, unknown> | null;
  after: Record<string, unknown> | null;
  tenant_id: string;
};

/** Expense audit events of a tenant (optionally one action / one entity), oldest first. */
export async function expenseAudit(
  tenantId: string,
  action?: string,
  entityId?: string,
): Promise<AuditRow[]> {
  const rows = await testDb<AuditRow[]>`
    select id, action, entity_type, entity_id, actor_user_id, actor_type, before, after, tenant_id
    from audit_logs
    where tenant_id = ${tenantId} and action in ${testDb(FINANCE_EXPENSE_ACTIONS)}
    order by created_at, id`;
  return rows.filter(
    (r) =>
      (action ? r.action === action : true) &&
      (entityId ? r.entity_id === entityId : true),
  );
}

export async function counts(
  tenantId: string,
): Promise<{ expenses: number; payments: number; audit: number }> {
  const [row] = await testDb<
    { expenses: string; payments: string; audit: string }[]
  >`
    select (select count(*) from expenses where tenant_id = ${tenantId})::text as expenses,
           (select count(*) from expense_payments where tenant_id = ${tenantId})::text as payments,
           (select count(*) from audit_logs where tenant_id = ${tenantId} and action in ${testDb(FINANCE_EXPENSE_ACTIONS)})::text as audit`;
  return {
    expenses: Number(row!.expenses),
    payments: Number(row!.payments),
    audit: Number(row!.audit),
  };
}

/** md5 over every expense, payment and expense-audit row of a tenant (all columns): a "byte-identical" probe. */
export async function tenantDigest(tenantId: string): Promise<string> {
  const [row] = await testDb<{ d: string }[]>`
    select md5(
      coalesce((select string_agg(to_jsonb(e)::text, '|' order by e.id) from expenses e where e.tenant_id = ${tenantId}), '') ||
      coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from expense_payments p where p.tenant_id = ${tenantId}), '') ||
      coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.id) from audit_logs a where a.tenant_id = ${tenantId} and a.action in ${testDb(FINANCE_EXPENSE_ACTIONS)}), '')
    ) as d`;
  return row!.d;
}

/** Digest of ONE expense row plus its payment rows (all columns). */
export async function expenseDigest(expenseId: string): Promise<string> {
  const [row] = await testDb<{ d: string }[]>`
    select md5(
      coalesce((select to_jsonb(e)::text from expenses e where e.id = ${expenseId}), '') ||
      coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from expense_payments p where p.expense_id = ${expenseId}), '')
    ) as d`;
  return row!.d;
}

/** Tenant-local "today" exactly as the database computes it (never the JS clock). */
export async function tenantToday(
  tenantId: string,
  offsetDays = 0,
): Promise<string> {
  const [row] = await testDb<{ d: string }[]>`
    select to_char(private.tenant_local_date(${tenantId}) + ${offsetDays}::int, 'YYYY-MM-DD') as d`;
  return row!.d;
}

/** Walks an expense through the given steps for fixture setup: returns its latest write result. */
export async function expectOk<T>(outcome: RpcOutcome<T>): Promise<T> {
  if (!outcome.ok)
    throw new Error(
      `expected success, got ${outcome.code}: ${outcome.message}`,
    );
  return outcome.data;
}

export { testDb };
