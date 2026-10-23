// @vitest-environment jsdom
/**
 * Faz LAUNCH.1A — the owner-approval section of /super-admin (components/platform/tenant-owner-approvals.tsx), in the
 * same isolation as the other UI tests: both Server Actions are mocked, both Supabase client factories THROW. Pinned: what
 * a row shows for each status, that only an OPEN approval offers "revoke", the exact form fields the approve action
 * receives, and how success and refusals are shown. The component carries no authority (the page renders it for a
 * platform owner only and the RPCs re-check) — see launch1a-signup-gate-app.test.ts and the database suite.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import messages from "@/messages/tr.json";
import { TenantOwnerApprovals } from "@/components/platform/tenant-owner-approvals";
import { approveTenantOwnerAction, revokeTenantOwnerApprovalAction } from "@/lib/modules/platform/actions";
import type { TenantOwnerApprovalRow } from "@/lib/modules/platform/approvals";
import { fail, ok } from "@/lib/errors";

vi.mock("@/lib/modules/platform/actions", () => ({
  approveTenantOwnerAction: vi.fn(),
  revokeTenantOwnerApprovalAction: vi.fn(),
  updateTenantStatusAction: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real server Supabase client was requested: this file must never touch Supabase");
  }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real browser Supabase client was requested: this file must never touch Supabase");
  }),
}));

const mockedApprove = vi.mocked(approveTenantOwnerAction);
const mockedRevoke = vi.mocked(revokeTenantOwnerApprovalAction);

const A = messages.SuperAdmin.approvals;
const labels: ComponentProps<typeof TenantOwnerApprovals>["labels"] = {
  heading: A.heading,
  description: A.description,
  emailLabel: A.emailLabel,
  noteLabel: A.noteLabel,
  daysLabel: A.daysLabel,
  daysOptions: [7, 14, 30, 60, 90].map((count) => ({ value: count, label: A.daysOption.replace("{count}", String(count)) })),
  submit: A.submit,
  submitting: A.submitting,
  approvedMessage: A.approvedMessage,
  revokedMessage: A.revokedMessage,
  revoke: A.revoke,
  revoking: A.revoking,
  empty: A.empty,
  columns: A.columns,
  status: A.status,
};

function row(over: Partial<TenantOwnerApprovalRow> & Pick<TenantOwnerApprovalRow, "id" | "email">): TenantOwnerApprovalRow {
  return {
    note: null,
    status: "approved",
    effectiveStatus: "approved",
    approvedAt: "2026-10-01T10:00:00Z",
    expiresAt: "2026-10-31T10:00:00Z",
    consumedAt: null,
    consumedTenantName: null,
    revokedAt: null,
    ...over,
  };
}

const ID = (n: number) => `0000000${n}-0000-4000-8000-00000000000${n}`;
const rows: TenantOwnerApprovalRow[] = [
  row({ id: ID(1), email: "acik@example.com", note: "Pilot salon önerisi" }),
  row({ id: ID(2), email: "suresi.doldu@example.com", effectiveStatus: "expired", expiresAt: "2026-09-01T10:00:00Z" }),
  row({ id: ID(3), email: "kullanildi@example.com", status: "consumed", effectiveStatus: "consumed", consumedAt: "2026-10-05T10:00:00Z", consumedTenantName: "Bella Hair" }),
  row({ id: ID(4), email: "geri.alindi@example.com", status: "revoked", effectiveStatus: "revoked", revokedAt: "2026-10-06T10:00:00Z" }),
];

const rowOf = (email: string) => screen.getByRole("row", { name: new RegExp(email.replace(".", "\\.")) });

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});

describe("approvals table", () => {
  it("shows each approval with its status label, expiry, created salon and note — dashes where there is none", () => {
    render(<TenantOwnerApprovals rows={rows} labels={labels} />);
    expect(within(rowOf("acik@example.com")).getByText(A.status.approved)).toBeTruthy();
    expect(within(rowOf("acik@example.com")).getByText("Pilot salon önerisi")).toBeTruthy();
    expect(within(rowOf("suresi.doldu@example.com")).getByText(A.status.expired)).toBeTruthy();
    expect(within(rowOf("kullanildi@example.com")).getByText(A.status.consumed)).toBeTruthy();
    expect(within(rowOf("kullanildi@example.com")).getByText("Bella Hair")).toBeTruthy();
    expect(within(rowOf("geri.alindi@example.com")).getByText(A.status.revoked)).toBeTruthy();
    expect(within(rowOf("geri.alindi@example.com")).getAllByText("—").length).toBeGreaterThanOrEqual(2);
  });

  it("only an OPEN approval (live, or past its expiry but never closed) offers 'revoke'; consumed and revoked rows are history", () => {
    render(<TenantOwnerApprovals rows={rows} labels={labels} />);
    expect(within(rowOf("acik@example.com")).getByRole("button", { name: A.revoke })).toBeTruthy();
    expect(within(rowOf("suresi.doldu@example.com")).getByRole("button", { name: A.revoke })).toBeTruthy();
    expect(within(rowOf("kullanildi@example.com")).queryByRole("button")).toBeNull();
    expect(within(rowOf("geri.alindi@example.com")).queryByRole("button")).toBeNull();
  });

  it("an empty list shows the empty state and no table", () => {
    render(<TenantOwnerApprovals rows={[]} labels={labels} />);
    expect(screen.getByText(A.empty)).toBeTruthy();
    expect(screen.queryByRole("table")).toBeNull();
  });
});

describe("approve form", () => {
  it("offers the e-mail, an optional note and the validity (default 30 days); the note field is capped at 500 characters", () => {
    render(<TenantOwnerApprovals rows={[]} labels={labels} />);
    const email = screen.getByLabelText(A.emailLabel) as HTMLInputElement;
    expect(email.type).toBe("email");
    expect(email.required).toBe(true);
    expect((screen.getByLabelText(A.noteLabel) as HTMLInputElement).maxLength).toBe(500);
    const days = screen.getByLabelText(A.daysLabel) as HTMLSelectElement;
    expect(days.value).toBe("30");
    expect([...days.options].map((o) => o.value)).toEqual(["7", "14", "30", "60", "90"]);
  });

  it("submitting sends exactly the entered e-mail, note and validity, then confirms", async () => {
    mockedApprove.mockResolvedValue(ok({ email: "yeni@example.com" }));
    render(<TenantOwnerApprovals rows={[]} labels={labels} />);
    fireEvent.change(screen.getByLabelText(A.emailLabel), { target: { value: "yeni@example.com" } });
    fireEvent.change(screen.getByLabelText(A.noteLabel), { target: { value: "Pilot salon" } });
    fireEvent.change(screen.getByLabelText(A.daysLabel), { target: { value: "14" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: A.submit }).closest("form")!);
    });

    await waitFor(() => expect(mockedApprove).toHaveBeenCalledTimes(1));
    const data = mockedApprove.mock.calls[0]![1] as FormData;
    expect(Object.fromEntries(data.entries())).toEqual({ email: "yeni@example.com", note: "Pilot salon", validDays: "14" });
    expect((await screen.findByRole("status")).textContent).toBe(A.approvedMessage);
  });

  it("a refusal (e.g. a support-level admin is not a platform owner) is shown as-is and nothing is confirmed", async () => {
    mockedApprove.mockResolvedValue(fail("UNAUTHORIZED", "Bu işlemi yalnızca platform sahibi yapabilir"));
    render(<TenantOwnerApprovals rows={[]} labels={labels} />);
    fireEvent.change(screen.getByLabelText(A.emailLabel), { target: { value: "yeni@example.com" } });
    await act(async () => {
      fireEvent.submit(screen.getByRole("button", { name: A.submit }).closest("form")!);
    });

    expect((await screen.findByRole("alert")).textContent).toBe("Bu işlemi yalnızca platform sahibi yapabilir");
    expect(screen.queryByRole("status")).toBeNull();
  });
});

describe("revoke", () => {
  it("posts exactly the approval id of that row (hidden field), then confirms in that row", async () => {
    mockedRevoke.mockResolvedValue(ok(null));
    render(<TenantOwnerApprovals rows={rows} labels={labels} />);
    await act(async () => {
      fireEvent.submit(within(rowOf("acik@example.com")).getByRole("button", { name: A.revoke }).closest("form")!);
    });

    await waitFor(() => expect(mockedRevoke).toHaveBeenCalledTimes(1));
    expect(Object.fromEntries((mockedRevoke.mock.calls[0]![1] as FormData).entries())).toEqual({ approvalId: ID(1) });
    expect((await within(rowOf("acik@example.com")).findByRole("status")).textContent).toBe(A.revokedMessage);
  });

  it("a refusal is shown inside the row it concerns", async () => {
    mockedRevoke.mockResolvedValue(fail("CONFLICT", "Bu onay zaten kullanıldı; salon oluşturulmuş"));
    render(<TenantOwnerApprovals rows={rows} labels={labels} />);
    await act(async () => {
      fireEvent.submit(within(rowOf("suresi.doldu@example.com")).getByRole("button", { name: A.revoke }).closest("form")!);
    });

    expect((await within(rowOf("suresi.doldu@example.com")).findByRole("alert")).textContent).toBe("Bu onay zaten kullanıldı; salon oluşturulmuş");
    expect(within(rowOf("acik@example.com")).queryByRole("alert")).toBeNull();
  });
});
