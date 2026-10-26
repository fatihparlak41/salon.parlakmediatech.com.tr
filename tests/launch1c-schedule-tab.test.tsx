// @vitest-environment jsdom
/**
 * Faz LAUNCH.1C — the per-person schedule editor knows only ONE block per weekday, while the guided setup can store a
 * lunch break (two blocks). This pins that a day with several blocks is shown read-only and re-sent EXACTLY as stored,
 * so saving the schedule never silently drops the afternoon block. Fully isolated (action mocked, Supabase throws).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { ScheduleTab } from "@/components/staff/tabs/schedule-tab";
import { updateStaffScheduleAction } from "@/lib/modules/staff/actions";
import { ok } from "@/lib/errors";

vi.mock("@/lib/modules/staff/actions", () => ({
  updateStaffScheduleAction: vi.fn(),
  createStaffExceptionAction: vi.fn(),
  deleteStaffExceptionAction: vi.fn(),
}));
vi.mock("@/lib/supabase/server", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real server Supabase client was requested — this file must never touch Supabase");
  }),
}));
vi.mock("@/lib/supabase/client", () => ({
  createClient: vi.fn(() => {
    throw new Error("a real browser Supabase client was requested — this file must never touch Supabase");
  }),
}));

const TENANT = "11111111-1111-4111-8111-111111111111";
const STAFF = "22222222-2222-4222-8222-222222222222";
const BRANCH = "33333333-3333-4333-8333-333333333333";

const row = (id: string, weekday: number, startTime: string, endTime: string) => ({ id, weekday, branchId: null, startTime, endTime });

function renderTab(schedule: ReturnType<typeof row>[]) {
  return render(
    <ScheduleTab
      tenantId={TENANT}
      tenantSlug="ornek"
      staffMemberId={STAFF}
      branches={[{ id: BRANCH, name: "Merkez Şube", isPrimary: true }]}
      canManage
      schedule={schedule}
      exceptions={[]}
      onScheduleSaved={() => undefined}
      onExceptionsChanged={() => undefined}
    />,
  );
}

beforeEach(() => vi.mocked(updateStaffScheduleAction).mockReset());
afterEach(() => cleanup());

describe("ScheduleTab with a multi-block (break) day", () => {
  it("shows the break day read-only and saves it back unchanged, while other days stay editable", async () => {
    vi.mocked(updateStaffScheduleAction).mockResolvedValue(ok(null));
    const { container } = renderTab([
      row("a", 1, "09:00", "13:00"),
      row("b", 1, "14:00", "18:00"),
      row("c", 2, "09:00", "18:00"),
    ]);
    const monday = container.querySelector('[data-multi-block-day="1"]')!;
    expect(monday.textContent).toContain("09:00–13:00 · 14:00–18:00");
    expect(monday.querySelector("input")).toBeNull();

    // edit Tuesday (a normal one-block day) — the end time input is the second time input of that row
    const timeInputs = container.querySelectorAll('input[type="time"]');
    expect(timeInputs).toHaveLength(2); // only Tuesday has editable inputs
    fireEvent.change(timeInputs[1]!, { target: { value: "17:00" } });
    fireEvent.click(screen.getByRole("button", { name: "Programı kaydet" }));
    await waitFor(() => expect(updateStaffScheduleAction).toHaveBeenCalledTimes(1));

    const sent = vi.mocked(updateStaffScheduleAction).mock.calls[0]![1] as { rows: { weekday: number; startTime: string; endTime: string }[] };
    expect(sent.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ weekday: 2, startTime: "09:00", endTime: "17:00" }),
        expect.objectContaining({ weekday: 1, startTime: "09:00", endTime: "13:00" }),
        expect.objectContaining({ weekday: 1, startTime: "14:00", endTime: "18:00" }),
      ]),
    );
    expect(sent.rows).toHaveLength(3);
  });

  it("a normal one-block schedule behaves exactly as before (no read-only day, one row per enabled day)", async () => {
    vi.mocked(updateStaffScheduleAction).mockResolvedValue(ok(null));
    const { container } = renderTab([row("a", 1, "09:00", "18:00"), row("b", 3, "10:00", "16:00")]);
    expect(container.querySelector("[data-multi-block-day]")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Programı kaydet" }));
    await waitFor(() => expect(updateStaffScheduleAction).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(updateStaffScheduleAction).mock.calls[0]![1] as { rows: { weekday: number }[] };
    expect(sent.rows.map((r) => r.weekday).sort()).toEqual([1, 3]);
  });
});
