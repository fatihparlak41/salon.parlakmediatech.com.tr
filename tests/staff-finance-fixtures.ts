/**
 * Faz FIN.1C.1 — shared fixtures for the staff-finance DB test files. Not a test file (vitest only collects *.test.ts[x]).
 *
 * Everything goes through the real public.* RPC surface as a real tenant member, in ONE transaction per call with the
 * role `authenticated` and the JWT claims set — exactly what a PostgREST request would see — so no test spends a
 * rate-limited password sign-in. Assertions about row state read ground truth through testDb. The RPC plumbing is a
 * deliberate copy of the FIN.1B.1 one: this module's tests do not depend on the expense test files.
 */
import { randomUUID } from "node:crypto";
import {
  testDb,
  createTestUser,
  createTestTenant,
  createStaffMember,
  createCustomRole,
  createTestMembershipFromTemplate,
  addMembership,
  cleanupTenants,
  cleanupUsers,
  asAuthenticatedUser,
  type TestUser,
  type TestStaffMember,
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

/** A database role other than authenticated (anon, service_role): EXECUTE on every wrapper must be denied (42501). */
export async function callRpcAsRole<T = Record<string, unknown>>(
  role: "anon" | "service_role",
  fn: string,
  args: RpcArg[],
): Promise<RpcOutcome<T>> {
  const { query, params } = buildCall(fn, args);
  try {
    const rows = await testDb.begin(async (sql) => {
      await sql.unsafe(`set local role ${role}`);
      return sql.unsafe(query, params as never[]);
    });
    return { ok: true, data: (rows[0] as unknown as { r: T }).r };
  } catch (error) {
    return toOutcome<T>(error);
  }
}

export const callRpcAsAnon = <T = Record<string, unknown>>(
  fn: string,
  args: RpcArg[],
) => callRpcAsRole<T>("anon", fn, args);

// ---------------------------------------------------------------------------------------------------------------
// Typed wrappers
// ---------------------------------------------------------------------------------------------------------------

export type WriteResult = {
  periodId: string;
  lineId?: string | null;
  paymentId?: string | null;
  lifecycle: string;
  paymentState: string;
  version: number;
  noop: boolean;
};

export type CreatePeriodInput = {
  tenantId: string | null;
  staffMemberId: string | null;
  periodMonth: string | null;
  /** undefined omits the argument; null sends SQL NULL. */
  idempotencyKey?: string | null;
  dueDate?: string | null;
};

export function createPeriodArgs(i: CreatePeriodInput): RpcArg[] {
  return [
    ["p_tenant_id", i.tenantId, "uuid"],
    ["p_staff_member_id", i.staffMemberId, "uuid"],
    ["p_period_month", i.periodMonth, "date"],
    ["p_idempotency_key", i.idempotencyKey, "uuid"],
    ["p_due_date", i.dueDate, "date"],
  ];
}

export function createPeriod(userId: string, i: CreatePeriodInput) {
  return callRpc<WriteResult>(
    userId,
    "create_staff_finance_period",
    createPeriodArgs(i),
  );
}

export type UpdatePeriodInput = {
  periodId: string | null;
  dueDate: string | null;
  expectedVersion?: number | null;
};

export function updatePeriodArgs(i: UpdatePeriodInput): RpcArg[] {
  return [
    ["p_period_id", i.periodId, "uuid"],
    ["p_due_date", i.dueDate, "date"],
    ["p_expected_version", i.expectedVersion, "integer"],
  ];
}

export function updatePeriod(userId: string, i: UpdatePeriodInput) {
  return callRpc<WriteResult>(
    userId,
    "update_staff_finance_period",
    updatePeriodArgs(i),
  );
}

export type AddLineInput = {
  periodId: string | null;
  kind: string | null;
  amount: number | string | null;
  description?: string | null;
  idempotencyKey?: string | null;
};

export function addLineArgs(i: AddLineInput): RpcArg[] {
  return [
    ["p_period_id", i.periodId, "uuid"],
    ["p_kind", i.kind, "text"],
    ["p_amount", i.amount, "numeric"],
    ["p_description", i.description, "text"],
    ["p_idempotency_key", i.idempotencyKey, "uuid"],
  ];
}

export function addLine(userId: string, i: AddLineInput) {
  return callRpc<WriteResult>(userId, "add_staff_period_line", addLineArgs(i));
}

export type UpdateLineInput = {
  lineId: string | null;
  amount: number | string | null;
  description?: string | null;
  expectedVersion?: number | null;
};

export function updateLineArgs(i: UpdateLineInput): RpcArg[] {
  return [
    ["p_line_id", i.lineId, "uuid"],
    ["p_amount", i.amount, "numeric"],
    ["p_description", i.description, "text"],
    ["p_expected_version", i.expectedVersion, "integer"],
  ];
}

export function updateLine(userId: string, i: UpdateLineInput) {
  return callRpc<WriteResult>(
    userId,
    "update_staff_period_line",
    updateLineArgs(i),
  );
}

export type VoidLineInput = {
  lineId: string | null;
  reason: string | null;
  expectedVersion?: number | null;
};

export function voidLineArgs(i: VoidLineInput): RpcArg[] {
  return [
    ["p_line_id", i.lineId, "uuid"],
    ["p_reason", i.reason, "text"],
    ["p_expected_version", i.expectedVersion, "integer"],
  ];
}

export function voidLine(userId: string, i: VoidLineInput) {
  return callRpc<WriteResult>(
    userId,
    "void_staff_period_line",
    voidLineArgs(i),
  );
}

export type PeriodTransitionInput = {
  periodId: string | null;
  expectedVersion?: number | null;
};

export function finalizeArgs(i: PeriodTransitionInput): RpcArg[] {
  return [
    ["p_period_id", i.periodId, "uuid"],
    ["p_expected_version", i.expectedVersion, "integer"],
  ];
}

export function finalizePeriod(userId: string, i: PeriodTransitionInput) {
  return callRpc<WriteResult>(
    userId,
    "finalize_staff_finance_period",
    finalizeArgs(i),
  );
}

export type ReopenInput = PeriodTransitionInput & { reason: string | null };

export function reopenArgs(i: ReopenInput): RpcArg[] {
  return [
    ["p_period_id", i.periodId, "uuid"],
    ["p_reason", i.reason, "text"],
    ["p_expected_version", i.expectedVersion, "integer"],
  ];
}

export function reopenPeriod(userId: string, i: ReopenInput) {
  return callRpc<WriteResult>(
    userId,
    "reopen_staff_finance_period",
    reopenArgs(i),
  );
}

export function cancelArgs(
  periodId: string | null,
  reason: string | null,
): RpcArg[] {
  return [
    ["p_period_id", periodId, "uuid"],
    ["p_reason", reason, "text"],
  ];
}

export function cancelPeriod(
  userId: string,
  periodId: string | null,
  reason: string | null,
) {
  return callRpc<WriteResult>(
    userId,
    "cancel_staff_finance_period",
    cancelArgs(periodId, reason),
  );
}

export type RecordPaymentInput = {
  periodId: string | null;
  purpose: string | null;
  amount: number | string | null;
  method: string | null;
  /** ISO string with an explicit offset (or null). */
  paidAt: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
};

export function recordArgs(i: RecordPaymentInput): RpcArg[] {
  return [
    ["p_period_id", i.periodId, "uuid"],
    ["p_purpose", i.purpose, "text"],
    ["p_amount", i.amount, "numeric"],
    ["p_method", i.method, "text"],
    ["p_paid_at", i.paidAt, "timestamptz"],
    ["p_note", i.note, "text"],
    ["p_idempotency_key", i.idempotencyKey, "uuid"],
  ];
}

export function recordPayment(userId: string, i: RecordPaymentInput) {
  return callRpc<WriteResult>(userId, "record_staff_payment", recordArgs(i));
}

export function voidPaymentArgs(
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
  return callRpc<WriteResult>(
    userId,
    "void_staff_payment",
    voidPaymentArgs(paymentId, reason),
  );
}

// ---- read models ------------------------------------------------------------------------------------------------

export type SplitFigure = { employee: number; employer: number };

export type OverviewPeriodRow = {
  periodId: string;
  staffName: string;
  currency: string;
  lifecycle: string;
  paymentState: string;
  grossEntitlement: number;
  employeeDeductions: number;
  paye: number;
  netPayable: number;
  paid: number;
  advances: number;
  employeeOutstanding: number;
  paidInExcess: number;
  socialInsurance: SplitFigure;
  providentFund: SplitFigure;
  employerCost: number;
  personnelCost: number;
  dueDate: string | null;
  isOverdue: boolean;
  daysOverdue: number | null;
  version: number;
};

export type CountedTotal = { total: number; count: number };

export type OverviewCurrency = {
  currency: string;
  grossEntitlement: number;
  employeeDeductions: number;
  paye: number;
  netPayable: number;
  paid: number;
  advances: number;
  employeeOutstanding: number;
  paidInExcess: number;
  employerCost: number;
  personnelCost: number;
  socialInsurance: SplitFigure;
  providentFund: SplitFigure;
  periodCount: number;
  cashPaidInMonth: number;
  employeeOutstandingAllTime: CountedTotal;
  paidInExcessAllTime: CountedTotal;
  overdueAllTime: CountedTotal;
};

export type StaffRef = { staffMemberId: string; fullName: string; status: string };

export type StaffOverview = {
  month: string;
  referenceDate: string;
  primaryCurrency: string;
  byCurrency: OverviewCurrency[];
  periods: OverviewPeriodRow[];
  staffWithoutPeriod: StaffRef[];
};

export function getOverview(
  userId: string,
  i: {
    tenantId: string | null;
    month?: string | null;
    referenceDate?: string | null;
  },
) {
  return callRpc<StaffOverview>(userId, "get_staff_finance_overview", [
    ["p_tenant_id", i.tenantId, "uuid"],
    ["p_month", i.month, "date"],
    ["p_reference_date", i.referenceDate, "date"],
  ]);
}

export type PeriodFlags = {
  canFinalize: boolean;
  finalizeBlockedReason: string | null;
  canReopen: boolean;
  reopenBlockedReason: string | null;
  canCancel: boolean;
  cancelBlockedReason: string | null;
  canAddStatementLine: boolean;
  canAddAdjustment: boolean;
  canAddEmployerCost: boolean;
  canPay: boolean;
  maxPayable: number | null;
};

export type LineView = {
  id: string;
  kind: string;
  lineGroup: string;
  institution: string | null;
  amount: number;
  description: string | null;
  status: string;
  postFinalization: boolean;
  voidReason: string | null;
  calculationSource: string;
  canEdit: boolean;
  canVoid: boolean;
};

export type PaymentView = {
  id: string;
  purpose: string;
  method: string;
  amount: number;
  paidAt: string;
  note: string | null;
  status: string;
  postFinalization: boolean;
  voidReason: string | null;
};

export type PeriodDetail = {
  id: string;
  staffName: string;
  periodMonth: string;
  currency: string;
  lifecycle: string;
  paymentState: string;
  dueDate: string | null;
  grossEntitlement: number;
  employeeDeductions: number;
  paye: number;
  netPayable: number;
  paid: number;
  advances: number;
  employeeOutstanding: number;
  paidInExcess: number;
  employerCost: number;
  personnelCost: number;
  socialInsurance: SplitFigure;
  providentFund: SplitFigure;
  finalizedStatement: {
    finalizedAt: string;
    grossEntitlement: number;
    employeeDeductions: number;
    netPayable: number;
  } | null;
  sinceFinalization: {
    grossEntitlement: number;
    employeeDeductions: number;
    netPayable: number;
  } | null;
  isOverdue: boolean;
  daysOverdue: number | null;
  flags: PeriodFlags;
  version: number;
  cancelledAt: string | null;
  cancelReason: string | null;
  createdAt: string;
  updatedAt: string;
  lines: LineView[];
  payments: PaymentView[];
};

export function getPeriod(
  userId: string,
  periodId: string | null,
  referenceDate?: string | null,
) {
  return callRpc<PeriodDetail>(userId, "get_staff_finance_period", [
    ["p_period_id", periodId, "uuid"],
    ["p_reference_date", referenceDate, "date"],
  ]);
}

export function listStaff(userId: string, tenantId: string | null) {
  return callRpc<StaffRef[]>(userId, "list_finance_staff", [
    ["p_tenant_id", tenantId, "uuid"],
  ]);
}

export type KindView = {
  code: string;
  lineGroup: string;
  institution: string | null;
  isAdjustment: boolean;
  displayOrder: number;
};

export function listKinds(userId: string, tenantId: string | null) {
  return callRpc<KindView[]>(userId, "list_staff_line_kinds", [
    ["p_tenant_id", tenantId, "uuid"],
  ]);
}

/** Every public wrapper (14), for permission and anon matrices. */
export const STAFF_FINANCE_WRAPPERS = [
  "list_finance_staff",
  "list_staff_line_kinds",
  "get_staff_finance_overview",
  "get_staff_finance_period",
  "create_staff_finance_period",
  "update_staff_finance_period",
  "add_staff_period_line",
  "update_staff_period_line",
  "void_staff_period_line",
  "finalize_staff_finance_period",
  "reopen_staff_finance_period",
  "cancel_staff_finance_period",
  "record_staff_payment",
  "void_staff_payment",
] as const;

export const STAFF_FINANCE_READ_WRAPPERS = STAFF_FINANCE_WRAPPERS.slice(0, 4);
export const STAFF_FINANCE_WRITE_WRAPPERS = STAFF_FINANCE_WRAPPERS.slice(4);

/** The 16 kinds, in catalog order: [code, group, institution, isAdjustment, displayOrder]. */
export const KIND_CATALOG = [
  ["salary", "earning", null, false, 10],
  ["bonus", "earning", null, false, 20],
  ["commission", "earning", null, false, 30],
  ["overtime", "earning", null, false, 40],
  ["extra_payment", "earning", null, false, 50],
  ["other_earning", "earning", null, false, 60],
  ["adjustment_credit", "earning", null, true, 90],
  ["employee_social_insurance", "employee_deduction", "social_insurance", false, 110],
  ["employee_provident_fund", "employee_deduction", "provident_fund", false, 120],
  ["paye", "employee_deduction", null, false, 130],
  ["other_deduction", "employee_deduction", null, false, 140],
  ["adjustment_debit", "employee_deduction", null, true, 190],
  ["employer_social_insurance", "employer_cost", "social_insurance", false, 210],
  ["employer_provident_fund", "employer_cost", "provident_fund", false, 220],
  ["private_insurance", "employer_cost", null, false, 230],
  ["other_employer_cost", "employer_cost", null, false, 240],
] as const;

export const EARNING_KINDS = KIND_CATALOG.filter(
  (k) => k[1] === "earning" && !k[3],
).map((k) => k[0]);
export const DEDUCTION_KINDS = KIND_CATALOG.filter(
  (k) => k[1] === "employee_deduction" && !k[3],
).map((k) => k[0]);
export const EMPLOYER_KINDS = KIND_CATALOG.filter(
  (k) => k[1] === "employer_cost",
).map((k) => k[0]);
export const ADJUSTMENT_KINDS = KIND_CATALOG.filter((k) => k[3]).map(
  (k) => k[0],
);

// ---------------------------------------------------------------------------------------------------------------
// The world: one tenant with every kind of caller and several staff members, plus a second tenant
// ---------------------------------------------------------------------------------------------------------------

export type StaffFinanceWorld = {
  tenant: { id: string; slug: string };
  otherTenant: { id: string; slug: string };
  owner: TestUser; // SALON_OWNER template: finance.staff_view + finance.staff_manage (M1)
  viewOnly: TestUser; // custom role: finance.staff_view
  manageOnly: TestUser; // custom role: finance.staff_manage
  financeOnly: TestUser; // custom role: finance.view + finance.manage (the expense keys: no inheritance)
  reportsOnly: TestUser; // custom role: reports.financial
  neither: TestUser; // custom role: appointments.view only
  manager: TestUser; // default Yönetici (SALON_MANAGER template)
  receptionist: TestUser; // default Resepsiyon
  stylist: TestUser; // default Personel
  accountant: TestUser; // ACCOUNTANT template (finance.view + finance.manage), still no staff keys
  stranger: TestUser; // authenticated user with no membership in the tenant
  otherOwner: TestUser; // owner of the second tenant
  staffA: TestStaffMember;
  staffB: TestStaffMember;
  staffInactive: TestStaffMember;
  staffDeleted: TestStaffMember;
  otherStaff: TestStaffMember; // staff member of the SECOND tenant
  users: TestUser[];
};

export async function createStaffFinanceWorld(
  label: string,
): Promise<StaffFinanceWorld> {
  const short = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`;
  const mk = (n: string) => createTestUser(`${label}-${n}`);
  const [
    owner,
    viewOnly,
    manageOnly,
    financeOnly,
    reportsOnly,
    neither,
    manager,
    receptionist,
    stylist,
    accountant,
    stranger,
    otherOwner,
  ] = await Promise.all(
    [
      "owner",
      "view",
      "manage",
      "fin",
      "rep",
      "neither",
      "mgr",
      "recep",
      "stylist",
      "acct",
      "stranger",
      "other",
    ].map(mk),
  );
  const tenantRow = await createTestTenant(`test-${label}-${short}`, owner!.id);
  const otherRow = await createTestTenant(
    `test-${label}-o${short}`,
    otherOwner!.id,
  );
  const tenant = { id: tenantRow.id, slug: tenantRow.slug };
  const otherTenant = { id: otherRow.id, slug: otherRow.slug };

  const viewRole = await createCustomRole(tenant.id, "PER Sadece Görüntüle", [
    "finance.staff_view",
  ]);
  const manageRole = await createCustomRole(tenant.id, "PER Sadece Yönet", [
    "finance.staff_manage",
  ]);
  const financeRole = await createCustomRole(tenant.id, "PER Gider Yetkileri", [
    "finance.view",
    "finance.manage",
  ]);
  const reportsRole = await createCustomRole(tenant.id, "PER Raporlar", [
    "reports.financial",
  ]);
  const neitherRole = await createCustomRole(
    tenant.id,
    "PER Sıradan Personel",
    ["appointments.view"],
  );
  await addMembership(tenant.id, viewOnly!.id, viewRole);
  await addMembership(tenant.id, manageOnly!.id, manageRole);
  await addMembership(tenant.id, financeOnly!.id, financeRole);
  await addMembership(tenant.id, reportsOnly!.id, reportsRole);
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

  const staffA = await createStaffMember(tenant.id, "Ayşe Yılmaz");
  const staffB = await createStaffMember(tenant.id, "Burak Demir");
  const staffInactive = await createStaffMember(tenant.id, "Cem Pasif");
  const staffDeleted = await createStaffMember(tenant.id, "Derya Silinmiş");
  const otherStaff = await createStaffMember(otherTenant.id, "Elif Başka");
  await testDb`update staff_members set status = 'inactive' where id = ${staffInactive.id}`;
  await testDb`update staff_members set deleted_at = now() where id = ${staffDeleted.id}`;

  const users = [
    owner!,
    viewOnly!,
    manageOnly!,
    financeOnly!,
    reportsOnly!,
    neither!,
    manager!,
    receptionist!,
    stylist!,
    accountant!,
    stranger!,
    otherOwner!,
  ];
  return {
    tenant,
    otherTenant,
    owner: owner!,
    viewOnly: viewOnly!,
    manageOnly: manageOnly!,
    financeOnly: financeOnly!,
    reportsOnly: reportsOnly!,
    neither: neither!,
    manager: manager!,
    receptionist: receptionist!,
    stylist: stylist!,
    accountant: accountant!,
    stranger: stranger!,
    otherOwner: otherOwner!,
    staffA,
    staffB,
    staffInactive,
    staffDeleted,
    otherStaff,
    users,
  };
}

export async function destroyStaffFinanceWorld(
  world: StaffFinanceWorld | undefined,
): Promise<void> {
  if (!world) return;
  await cleanupTenants([world.tenant.id, world.otherTenant.id]);
  await cleanupUsers(world.users.map((u) => u.id));
}

/** A fresh staff member of the main tenant (one active period per staff member and month, so tests that need several
 * independent periods take several staff members). */
export async function newStaff(
  world: StaffFinanceWorld,
  label = "Personel",
): Promise<TestStaffMember> {
  return createStaffMember(world.tenant.id, uniqueText(label));
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

let seq = 0;
export function uniqueText(prefix: string): string {
  seq += 1;
  return `${prefix} ${seq}-${Math.random().toString(36).slice(2, 7)}`;
}

/** A month that is always allowed (the tenant-local month is at least this one): the default for fixtures. */
export const DEFAULT_MONTH = "2026-09-01";

/** A valid create payload with sensible defaults; override what the test is about. */
export function validPeriod(
  world: StaffFinanceWorld,
  staffMemberId: string,
  o: Partial<CreatePeriodInput> = {},
): CreatePeriodInput {
  return {
    tenantId: world.tenant.id,
    staffMemberId,
    periodMonth: DEFAULT_MONTH,
    idempotencyKey: newKey(),
    ...o,
  };
}

/** Create a period through the RPC as the owner (fresh staff member unless one is given); throws if it fails. */
export async function makePeriod(
  world: StaffFinanceWorld,
  o: Partial<CreatePeriodInput> = {},
  as: TestUser = world.owner,
): Promise<WriteResult> {
  const staffMemberId = o.staffMemberId ?? (await newStaff(world)).id;
  const out = await createPeriod(as.id, validPeriod(world, staffMemberId, o));
  if (!out.ok)
    throw new Error(
      `fixture create_staff_finance_period failed: ${out.code} ${out.message}`,
    );
  return out.data;
}

export async function makeLine(
  periodId: string,
  kind: string,
  amount: number | string,
  o: Partial<AddLineInput> = {},
  as: TestUser,
): Promise<WriteResult> {
  const out = await addLine(as.id, {
    periodId,
    kind,
    amount,
    description:
      o.description === undefined && /^adjustment_/.test(kind)
        ? "Düzeltme"
        : o.description,
    idempotencyKey: newKey(),
    ...o,
  });
  if (!out.ok)
    throw new Error(
      `fixture add_staff_period_line failed: ${out.code} ${out.message}`,
    );
  return out.data;
}

export async function makePayment(
  periodId: string,
  amount: number | string,
  o: Partial<RecordPaymentInput> = {},
  as: TestUser,
): Promise<WriteResult> {
  const out = await recordPayment(as.id, {
    periodId,
    purpose: "salary",
    amount,
    method: "cash",
    paidAt: instantAgo(5),
    idempotencyKey: newKey(),
    ...o,
  });
  if (!out.ok)
    throw new Error(
      `fixture record_staff_payment failed: ${out.code} ${out.message}`,
    );
  return out.data;
}

export type PeriodRow = {
  id: string;
  tenant_id: string;
  staff_member_id: string;
  staff_display_name: string;
  period_month: string;
  currency: string;
  lifecycle: string;
  due_date: string | null;
  earning_total: string;
  employee_deduction_total: string;
  employer_cost_total: string;
  paid_total: string;
  advance_total: string;
  content_revision: number;
  net_payable: string;
  payment_state: string;
  finalized_earning_total: string | null;
  finalized_deduction_total: string | null;
  finalized_net_payable: string | null;
  version: number;
  idempotency_key: string;
  idempotency_fingerprint: string;
  finalized_at: Date | null;
  finalized_by: string | null;
  cancelled_at: Date | null;
  cancelled_by: string | null;
  cancel_reason: string | null;
  created_by: string | null;
  created_at: Date;
  updated_at: Date;
};

export async function periodRow(id: string): Promise<PeriodRow> {
  const [row] = await testDb<PeriodRow[]>`
    select id, tenant_id, staff_member_id, staff_display_name, to_char(period_month, 'YYYY-MM-DD') as period_month,
           currency, lifecycle, to_char(due_date, 'YYYY-MM-DD') as due_date,
           earning_total::text as earning_total, employee_deduction_total::text as employee_deduction_total,
           employer_cost_total::text as employer_cost_total, paid_total::text as paid_total,
           advance_total::text as advance_total, content_revision, net_payable::text as net_payable, payment_state,
           finalized_earning_total::text as finalized_earning_total,
           finalized_deduction_total::text as finalized_deduction_total,
           finalized_net_payable::text as finalized_net_payable, version, idempotency_key, idempotency_fingerprint,
           finalized_at, finalized_by, cancelled_at, cancelled_by, cancel_reason, created_by, created_at, updated_at
    from staff_finance_periods where id = ${id}`;
  if (!row) throw new Error(`period ${id} not found`);
  return row;
}

export type LineRow = {
  id: string;
  tenant_id: string;
  period_id: string;
  currency: string;
  kind: string;
  line_group: string;
  institution: string | null;
  amount: string;
  description: string | null;
  calculation_source: string;
  status: string;
  post_finalization: boolean;
  idempotency_key: string;
  idempotency_fingerprint: string;
  voided_at: Date | null;
  void_reason: string | null;
  updated_at: Date;
};

export async function lineRows(periodId: string): Promise<LineRow[]> {
  return testDb<LineRow[]>`
    select id, tenant_id, period_id, currency, kind, line_group, institution, amount::text as amount, description,
           calculation_source, status, post_finalization, idempotency_key, idempotency_fingerprint, voided_at,
           void_reason, updated_at
    from staff_period_lines where period_id = ${periodId} order by created_at, id`;
}

export type PaymentRow = {
  id: string;
  tenant_id: string;
  period_id: string;
  currency: string;
  purpose: string;
  method: string;
  amount: string;
  paid_at: Date;
  note: string | null;
  status: string;
  post_finalization: boolean;
  idempotency_key: string;
  voided_at: Date | null;
  void_reason: string | null;
};

export async function paymentRows(periodId: string): Promise<PaymentRow[]> {
  return testDb<PaymentRow[]>`
    select id, tenant_id, period_id, currency, purpose, method, amount::text as amount, paid_at, note, status,
           post_finalization, idempotency_key, voided_at, void_reason
    from staff_payments where period_id = ${periodId} order by created_at, id`;
}

/** Live totals straight from the child rows (an independent oracle for the cached columns). */
export async function oracleTotals(periodId: string): Promise<{
  earning: number;
  deduction: number;
  employer: number;
  paid: number;
  advances: number;
}> {
  const [row] = await testDb<
    {
      earning: string;
      deduction: string;
      employer: string;
      paid: string;
      advances: string;
    }[]
  >`
    select
      coalesce((select sum(amount) from staff_period_lines where period_id = ${periodId} and status = 'active' and line_group = 'earning'), 0)::text as earning,
      coalesce((select sum(amount) from staff_period_lines where period_id = ${periodId} and status = 'active' and line_group = 'employee_deduction'), 0)::text as deduction,
      coalesce((select sum(amount) from staff_period_lines where period_id = ${periodId} and status = 'active' and line_group = 'employer_cost'), 0)::text as employer,
      coalesce((select sum(amount) from staff_payments where period_id = ${periodId} and status = 'posted'), 0)::text as paid,
      coalesce((select sum(amount) from staff_payments where period_id = ${periodId} and status = 'posted' and purpose = 'advance'), 0)::text as advances`;
  return {
    earning: Number(row!.earning),
    deduction: Number(row!.deduction),
    employer: Number(row!.employer),
    paid: Number(row!.paid),
    advances: Number(row!.advances),
  };
}

export const STAFF_FINANCE_ACTIONS = [
  "finance.staff_period_created",
  "finance.staff_period_updated",
  "finance.staff_period_finalized",
  "finance.staff_period_reopened",
  "finance.staff_period_cancelled",
  "finance.staff_line_added",
  "finance.staff_line_updated",
  "finance.staff_line_voided",
  "finance.staff_payment_recorded",
  "finance.staff_payment_voided",
] as const;

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

/** Staff-finance audit events of a tenant (optionally one action / one entity), oldest first. */
export async function staffAudit(
  tenantId: string,
  action?: string,
  entityId?: string,
): Promise<AuditRow[]> {
  const rows = await testDb<AuditRow[]>`
    select id, action, entity_type, entity_id, actor_user_id, actor_type, before, after, tenant_id
    from audit_logs
    where tenant_id = ${tenantId} and action in ${testDb([...STAFF_FINANCE_ACTIONS])}
    order by created_at, id`;
  return rows.filter(
    (r) =>
      (action ? r.action === action : true) &&
      (entityId ? r.entity_id === entityId : true),
  );
}

export async function counts(
  tenantId: string,
): Promise<{ periods: number; lines: number; payments: number; audit: number }> {
  const [row] = await testDb<
    { periods: string; lines: string; payments: string; audit: string }[]
  >`
    select (select count(*) from staff_finance_periods where tenant_id = ${tenantId})::text as periods,
           (select count(*) from staff_period_lines where tenant_id = ${tenantId})::text as lines,
           (select count(*) from staff_payments where tenant_id = ${tenantId})::text as payments,
           (select count(*) from audit_logs where tenant_id = ${tenantId} and action in ${testDb([...STAFF_FINANCE_ACTIONS])})::text as audit`;
  return {
    periods: Number(row!.periods),
    lines: Number(row!.lines),
    payments: Number(row!.payments),
    audit: Number(row!.audit),
  };
}

/** md5 over every staff-finance row and audit row of a tenant (all columns): a "byte-identical" probe. */
export async function tenantDigest(tenantId: string): Promise<string> {
  const [row] = await testDb<{ d: string }[]>`
    select md5(
      coalesce((select string_agg(to_jsonb(p)::text, '|' order by p.id) from staff_finance_periods p where p.tenant_id = ${tenantId}), '') ||
      coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.id) from staff_period_lines l where l.tenant_id = ${tenantId}), '') ||
      coalesce((select string_agg(to_jsonb(y)::text, '|' order by y.id) from staff_payments y where y.tenant_id = ${tenantId}), '') ||
      coalesce((select string_agg(to_jsonb(a)::text, '|' order by a.id) from audit_logs a where a.tenant_id = ${tenantId} and a.action in ${testDb([...STAFF_FINANCE_ACTIONS])}), '')
    ) as d`;
  return row!.d;
}

/** Digest of ONE period row plus its line and payment rows (all columns). */
export async function periodDigest(periodId: string): Promise<string> {
  const [row] = await testDb<{ d: string }[]>`
    select md5(
      coalesce((select to_jsonb(p)::text from staff_finance_periods p where p.id = ${periodId}), '') ||
      coalesce((select string_agg(to_jsonb(l)::text, '|' order by l.id) from staff_period_lines l where l.period_id = ${periodId}), '') ||
      coalesce((select string_agg(to_jsonb(y)::text, '|' order by y.id) from staff_payments y where y.period_id = ${periodId}), '')
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

/** First day of the tenant-local month plus `offsetMonths`, as the database computes it. */
export async function tenantMonth(
  tenantId: string,
  offsetMonths = 0,
): Promise<string> {
  const [row] = await testDb<{ d: string }[]>`
    select to_char((date_trunc('month', private.tenant_local_date(${tenantId})::timestamp) + (${offsetMonths}::int * interval '1 month'))::date, 'YYYY-MM-DD') as d`;
  return row!.d;
}

export async function expectOk<T>(outcome: RpcOutcome<T>): Promise<T> {
  if (!outcome.ok)
    throw new Error(
      `expected success, got ${outcome.code}: ${outcome.message}`,
    );
  return outcome.data;
}

export { testDb };
