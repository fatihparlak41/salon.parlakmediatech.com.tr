// @vitest-environment jsdom
/**
 * Faz LAUNCH.1A — component coverage for the Owner-facing Team management UI (members table + the role / suspend /
 * restore / remove dialogs), in the same isolation as the expense and checkout UI tests: the four Server Actions are
 * mocked (their Core is covered against a real database elsewhere), the router is a spy, and both Supabase client
 * factories THROW so a path that tried to reach a real project fails loudly.
 *
 * What is pinned: who gets buttons (only manageable, non-self rows), that every restrictive action goes through a
 * confirmation that names the person and sends NOTHING until confirmed, the exact payload each action sends, how a
 * stale-state conflict and an ordinary refusal are shown, the pending state, per-member dialog state, and that no
 * internal identifier or e-mail address is ever rendered.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import type { ComponentProps } from "react";
import trMessages from "@/messages/tr.json";
import { TeamPageClient } from "@/components/team/team-page-client";
import {
  changeMemberRoleAction,
  reactivateMemberAction,
  removeMemberAction,
  suspendMemberAction,
} from "@/lib/modules/team/member-actions";
import { MEMBER_STATE_CHANGED_MESSAGE } from "@/lib/modules/team/helpers";
import type { AssignableRoleOption, TeamMemberRow } from "@/lib/modules/team/queries";
import { fail, ok } from "@/lib/errors";

const nav = vi.hoisted(() => ({ push: vi.fn(), refresh: vi.fn(), replace: vi.fn() }));

vi.mock("next/navigation", () => ({
  useRouter: () => nav,
  usePathname: () => "/app/bella-hair/team",
}));
vi.mock("@/lib/modules/team/member-actions", () => ({
  changeMemberRoleAction: vi.fn(),
  suspendMemberAction: vi.fn(),
  reactivateMemberAction: vi.fn(),
  removeMemberAction: vi.fn(),
}));
vi.mock("@/lib/modules/team/actions", () => ({
  createTeamInvitationAction: vi.fn(),
  resendTeamInvitationAction: vi.fn(),
  revokeTeamInvitationAction: vi.fn(),
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

const mockedChangeRole = vi.mocked(changeMemberRoleAction);
const mockedSuspend = vi.mocked(suspendMemberAction);
const mockedReactivate = vi.mocked(reactivateMemberAction);
const mockedRemove = vi.mocked(removeMemberAction);

const T = trMessages.Team;
const A = T.memberActions;

const TENANT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const SLUG = "bella-hair";
const ROLE_OWNER = "10000000-0000-4000-8000-000000000001";
const ROLE_MANAGER = "10000000-0000-4000-8000-000000000002";
const ROLE_RECEPTION = "10000000-0000-4000-8000-000000000003";
const ROLE_PERSONEL = "10000000-0000-4000-8000-000000000004";
const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

function member(over: Partial<TeamMemberRow> & Pick<TeamMemberRow, "membershipId" | "displayName">): TeamMemberRow {
  return {
    roleId: ROLE_PERSONEL,
    roleName: "Personel",
    status: "active",
    isSelf: false,
    linkedStaffName: null,
    canManage: true,
    ...over,
  };
}

const M_SELF = "20000000-0000-4000-8000-000000000001";
const M_PEER = "20000000-0000-4000-8000-000000000002";
const M_PERSONEL = "20000000-0000-4000-8000-000000000003";
const M_SUSPENDED = "20000000-0000-4000-8000-000000000004";
const M_FROZEN = "20000000-0000-4000-8000-000000000005";

const members: TeamMemberRow[] = [
  member({ membershipId: M_SELF, displayName: "Ayşe Sahip", roleId: ROLE_OWNER, roleName: "Salon Sahibi", isSelf: true, canManage: false }),
  member({ membershipId: M_PEER, displayName: "Burak Ortak", roleId: ROLE_OWNER, roleName: "Salon Sahibi" }),
  member({ membershipId: M_PERSONEL, displayName: "Fatma Personel", linkedStaffName: "Fatma Kuaför" }),
  member({ membershipId: M_SUSPENDED, displayName: "Gül Askıda", roleId: ROLE_RECEPTION, roleName: "Resepsiyon", status: "suspended" }),
  member({ membershipId: M_FROZEN, displayName: "Cemile Yönetici", roleId: ROLE_MANAGER, roleName: "Yönetici", canManage: false }),
];

const assignableRoles: AssignableRoleOption[] = [
  { id: ROLE_OWNER, name: "Salon Sahibi" },
  { id: ROLE_MANAGER, name: "Yönetici" },
  { id: ROLE_RECEPTION, name: "Resepsiyon" },
  { id: ROLE_PERSONEL, name: "Personel" },
];

const labels = { ...T } as unknown as ComponentProps<typeof TeamPageClient>["labels"];

function renderTeam(over: { members?: TeamMemberRow[]; assignableRoles?: AssignableRoleOption[] } = {}) {
  return render(
    <TeamPageClient
      tenantId={TENANT_ID}
      tenantSlug={SLUG}
      initialMembers={over.members ?? members}
      initialInvitations={[]}
      staffLinkOptions={[]}
      roleOptions={assignableRoles}
      assignableRoles={over.assignableRoles ?? assignableRoles}
      labels={labels}
    />,
  );
}

/** The desktop table (jsdom applies no CSS, so the mobile card list renders too — queries are scoped to the table). */
const table = () => screen.getByRole("table");
const rowOf = (name: string) => within(table()).getByRole("row", { name: new RegExp(name) });
const named = (label: string, person: string) => `${label}: ${person}`;

// --- jsdom polyfills Base UI's Dialog/Select reach for (the same documented gaps as the other UI tests) ---
beforeEach(() => {
  if (!("ResizeObserver" in globalThis)) {
    class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    globalThis.ResizeObserver = ResizeObserverStub;
  }
  if (!Element.prototype.hasPointerCapture) Element.prototype.hasPointerCapture = () => false;
  if (!Element.prototype.setPointerCapture) Element.prototype.setPointerCapture = () => {};
  if (!Element.prototype.releasePointerCapture) Element.prototype.releasePointerCapture = () => {};
  if (!Element.prototype.scrollIntoView) Element.prototype.scrollIntoView = () => {};
  if (!globalThis.matchMedia) {
    // @ts-expect-error -- test-only stub
    globalThis.matchMedia = () => ({
      matches: false,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
    });
  }
});

afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("members table", () => {
  it("lists every member with name, role, linked staff name and a status badge; 'Siz' only on the caller's own row", () => {
    renderTeam();
    const rows = within(table()).getAllByRole("row");
    expect(rows).toHaveLength(1 + members.length); // header + one per member

    expect(within(rowOf("Fatma Personel")).getByText("Personel")).toBeTruthy();
    expect(within(rowOf("Fatma Personel")).getByText("Fatma Kuaför")).toBeTruthy();
    expect(within(rowOf("Fatma Personel")).getByText(A.statusActive)).toBeTruthy();
    expect(within(rowOf("Gül Askıda")).getByText(A.statusSuspended)).toBeTruthy();
    expect(within(rowOf("Gül Askıda")).getByText("Resepsiyon")).toBeTruthy();

    const selfBadges = within(table()).getAllByText(A.selfBadge);
    expect(selfBadges).toHaveLength(1);
    expect(within(rowOf("Ayşe Sahip")).getByText(A.selfBadge)).toBeTruthy();
  });

  it("buttons exist ONLY for manageable, non-self rows — never on the caller's own row nor on a row the database says they cannot manage", () => {
    renderTeam();
    for (const none of ["Ayşe Sahip", "Cemile Yönetici"]) {
      expect(within(rowOf(none)).queryAllByRole("button"), none).toHaveLength(0);
      expect(within(rowOf(none)).getByText(A.noActions)).toBeTruthy();
    }
    // three actions per manageable row (peer owner, active personel, suspended receptionist) = 9 in the table
    expect(within(table()).getAllByRole("button")).toHaveLength(9);
  });

  it("an ACTIVE member offers change role / suspend / remove; a SUSPENDED member offers change role / restore / remove — each named after the person", () => {
    renderTeam();
    const active = rowOf("Fatma Personel");
    expect(within(active).getByRole("button", { name: named(A.changeRole, "Fatma Personel") })).toBeTruthy();
    expect(within(active).getByRole("button", { name: named(A.suspend, "Fatma Personel") })).toBeTruthy();
    expect(within(active).getByRole("button", { name: named(A.remove, "Fatma Personel") })).toBeTruthy();
    expect(within(active).queryByRole("button", { name: new RegExp(A.reactivate) })).toBeNull();

    const suspended = rowOf("Gül Askıda");
    expect(within(suspended).getByRole("button", { name: named(A.changeRole, "Gül Askıda") })).toBeTruthy();
    expect(within(suspended).getByRole("button", { name: named(A.reactivate, "Gül Askıda") })).toBeTruthy();
    expect(within(suspended).getByRole("button", { name: named(A.remove, "Gül Askıda") })).toBeTruthy();
    expect(within(suspended).queryByRole("button", { name: new RegExp(A.suspend) })).toBeNull();
  });

  it("belt and braces: even if a row were flagged both 'self' and 'manageable', the caller still gets no buttons on their own row", () => {
    renderTeam({
      members: [
        member({ membershipId: M_SELF, displayName: "Ayşe Sahip", roleId: ROLE_OWNER, roleName: "Salon Sahibi", isSelf: true, canManage: true }),
        member({ membershipId: M_PERSONEL, displayName: "Fatma Personel" }),
      ],
    });
    expect(within(rowOf("Ayşe Sahip")).queryAllByRole("button")).toHaveLength(0);
    expect(within(rowOf("Fatma Personel")).getAllByRole("button")).toHaveLength(3);
  });

  it("renders no identifier: no UUID anywhere in the DOM, none of the membership or role ids", () => {
    const { container } = renderTeam();
    expect(container.innerHTML).not.toMatch(UUID);
    expect(document.body.innerHTML).not.toMatch(UUID);
    for (const id of [M_SELF, M_PEER, M_PERSONEL, M_SUSPENDED, M_FROZEN, ROLE_OWNER, ROLE_PERSONEL, TENANT_ID]) {
      expect(document.body.innerHTML.includes(id), id).toBe(false);
    }
  });

  it("an empty list shows the empty state instead of a table", () => {
    renderTeam({ members: [] });
    expect(screen.queryByRole("table")).toBeNull();
    expect(screen.getByText(T.noMembersTitle)).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("suspend / restore / remove — confirmation first, then exactly one action", () => {
  const confirm = {
    suspend: { button: () => A.suspend, title: A.suspendDialog.title, confirm: A.suspendDialog.confirm, banner: A.banners.suspended, person: "Fatma Personel", id: M_PERSONEL, action: mockedSuspend },
    reactivate: { button: () => A.reactivate, title: A.reactivateDialog.title, confirm: A.reactivateDialog.confirm, banner: A.banners.reactivated, person: "Gül Askıda", id: M_SUSPENDED, action: mockedReactivate },
    remove: { button: () => A.remove, title: A.removeDialog.title, confirm: A.removeDialog.confirm, banner: A.banners.removed, person: "Fatma Personel", id: M_PERSONEL, action: mockedRemove },
  } as const;

  async function openDialog(kind: keyof typeof confirm) {
    const spec = confirm[kind];
    fireEvent.click(within(rowOf(spec.person)).getByRole("button", { name: named(spec.button(), spec.person) }));
    return screen.findByRole("alertdialog");
  }

  describe.each(Object.keys(confirm) as (keyof typeof confirm)[])("%s", (kind) => {
    const spec = confirm[kind];

    it("opens a confirmation that names the person and has sent NOTHING yet; 'Vazgeç' closes it without calling anything", async () => {
      renderTeam();
      const dialog = await openDialog(kind);
      expect(within(dialog).getByText(spec.title)).toBeTruthy();
      expect(dialog.textContent).toContain(spec.person);
      expect(spec.action).not.toHaveBeenCalled();

      fireEvent.click(within(dialog).getByRole("button", { name: A.suspendDialog.cancel }));
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(spec.action).not.toHaveBeenCalled();
    });

    it("on confirmation sends exactly { tenantId, tenantSlug, membershipId } once, shows the success banner and closes", async () => {
      spec.action.mockResolvedValue(ok({ membershipId: spec.id }));
      renderTeam();
      const dialog = await openDialog(kind);
      fireEvent.click(within(dialog).getByRole("button", { name: spec.confirm }));

      await waitFor(() => expect(spec.action).toHaveBeenCalledTimes(1));
      expect(spec.action.mock.calls[0]![1]).toEqual({ tenantId: TENANT_ID, tenantSlug: SLUG, membershipId: spec.id });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
      expect(screen.getByRole("status").textContent).toBe(spec.banner);
    });

    it("a stale-state conflict is shown in the dialog (it stays open) and the page data is refreshed", async () => {
      spec.action.mockResolvedValue(fail("CONFLICT", MEMBER_STATE_CHANGED_MESSAGE));
      renderTeam();
      const dialog = await openDialog(kind);
      fireEvent.click(within(dialog).getByRole("button", { name: spec.confirm }));

      const alert = await within(dialog).findByRole("alert");
      expect(alert.textContent).toBe(MEMBER_STATE_CHANGED_MESSAGE);
      expect(nav.refresh).toHaveBeenCalledTimes(1);
      expect(screen.getByRole("alertdialog")).toBeTruthy();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("an ordinary refusal is shown as-is, the dialog stays open, no refresh and no success banner", async () => {
      spec.action.mockResolvedValue(fail("UNAUTHORIZED", "Bu üye üzerinde işlem yapma yetkiniz yok"));
      renderTeam();
      const dialog = await openDialog(kind);
      fireEvent.click(within(dialog).getByRole("button", { name: spec.confirm }));

      expect((await within(dialog).findByRole("alert")).textContent).toBe("Bu üye üzerinde işlem yapma yetkiniz yok");
      expect(nav.refresh).not.toHaveBeenCalled();
      expect(screen.queryByRole("status")).toBeNull();
    });

    it("while the request is in flight both buttons are disabled and a second press sends nothing more", async () => {
      let finish!: (value: Awaited<ReturnType<typeof suspendMemberAction>>) => void;
      spec.action.mockImplementation(
        () =>
          new Promise((resolve) => {
            finish = resolve;
          }),
      );
      renderTeam();
      const dialog = await openDialog(kind);
      fireEvent.click(within(dialog).getByRole("button", { name: spec.confirm }));

      await waitFor(() => {
        const buttons = within(dialog).getAllByRole("button");
        expect(buttons.every((b) => (b as HTMLButtonElement).disabled)).toBe(true);
      });
      // the confirm button now shows this action's own "in progress" wording
      const progress = { suspend: A.suspendDialog.pending, reactivate: A.reactivateDialog.pending, remove: A.removeDialog.pending }[kind];
      expect(within(dialog).getByRole("button", { name: progress })).toBeTruthy();
      for (const button of within(dialog).getAllByRole("button")) fireEvent.click(button);
      expect(spec.action).toHaveBeenCalledTimes(1);

      await act(async () => {
        finish(ok({ membershipId: spec.id }));
      });
      await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    });
  });

  it("the three confirmations describe the consequence in plain words (suspend: no entry, records kept; remove: history kept, re-invite needed)", async () => {
    renderTeam();
    let dialog = await openDialog("suspend");
    expect(dialog.textContent).toContain("Kayıtları silinmez");
    fireEvent.click(within(dialog).getByRole("button", { name: A.suspendDialog.cancel }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());

    dialog = await openDialog("remove");
    expect(dialog.textContent).toContain("yeni bir davet");
    expect(dialog.textContent).toContain("geçmiş randevular korunur");
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("change role", () => {
  async function openRoleDialog(person: string) {
    fireEvent.click(within(rowOf(person)).getByRole("button", { name: named(A.changeRole, person) }));
    return screen.findByRole("dialog");
  }

  /** Base UI's Select opens on pointer/mouse down; try the real interaction, option by accessible name. */
  async function chooseRole(dialog: HTMLElement, roleName: string) {
    const trigger = within(dialog).getByRole("combobox");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const option = await screen.findByRole("option", { name: roleName });
    // Base UI only commits a click that began as a pointer press on the item (so a click that merely ends under the
    // cursor after the popup opened cannot select): press, then click.
    fireEvent.pointerDown(option, { button: 0, pointerType: "mouse" });
    fireEvent.click(option);
    await waitFor(() => expect(screen.queryByRole("listbox")).toBeNull());
  }

  it("opens a dialog naming the person; the picker offers every assignable role EXCEPT the one the member already has", async () => {
    renderTeam();
    const dialog = await openRoleDialog("Fatma Personel");
    expect(within(dialog).getByText(A.roleDialog.title)).toBeTruthy();
    expect(dialog.textContent).toContain("Fatma Personel");

    const trigger = within(dialog).getByRole("combobox");
    fireEvent.pointerDown(trigger, { button: 0, pointerType: "mouse" });
    fireEvent.mouseDown(trigger, { button: 0 });
    fireEvent.click(trigger);
    const options = await screen.findAllByRole("option");
    expect(options.map((o) => o.textContent).sort()).toEqual(["Resepsiyon", "Salon Sahibi", "Yönetici"].sort());
    expect(mockedChangeRole).not.toHaveBeenCalled();
  });

  it("the save button stays disabled until a role is chosen; choosing one sends exactly the new role AND the role the page showed", async () => {
    mockedChangeRole.mockResolvedValue(ok({ membershipId: M_PERSONEL }));
    renderTeam();
    const dialog = await openRoleDialog("Fatma Personel");
    const save = within(dialog).getByRole("button", { name: A.roleDialog.submit }) as HTMLButtonElement;
    expect(save.disabled).toBe(true);

    await chooseRole(dialog, "Resepsiyon");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);

    await waitFor(() => expect(mockedChangeRole).toHaveBeenCalledTimes(1));
    expect(mockedChangeRole.mock.calls[0]![1]).toEqual({
      tenantId: TENANT_ID,
      tenantSlug: SLUG,
      membershipId: M_PERSONEL,
      newRoleId: ROLE_RECEPTION,
      expectedRoleId: ROLE_PERSONEL,
    });
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(screen.getByRole("status").textContent).toBe(A.banners.roleChanged);
  });

  it("a stale-role conflict is shown in the dialog and refreshes the page; the dialog stays open", async () => {
    mockedChangeRole.mockResolvedValue(fail("CONFLICT", MEMBER_STATE_CHANGED_MESSAGE));
    renderTeam();
    const dialog = await openRoleDialog("Fatma Personel");
    await chooseRole(dialog, "Yönetici");
    fireEvent.click(within(dialog).getByRole("button", { name: A.roleDialog.submit }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(MEMBER_STATE_CHANGED_MESSAGE);
    expect(nav.refresh).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("dialog")).toBeTruthy();
  });

  it("a database refusal (e.g. a role above the caller's own) is shown as-is, with no refresh", async () => {
    mockedChangeRole.mockResolvedValue(fail("UNAUTHORIZED", "Sahip olmadığınız izinleri içeren bir rol atayamazsınız"));
    renderTeam();
    const dialog = await openRoleDialog("Fatma Personel");
    await chooseRole(dialog, "Salon Sahibi");
    fireEvent.click(within(dialog).getByRole("button", { name: A.roleDialog.submit }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe("Sahip olmadığınız izinleri içeren bir rol atayamazsınız");
    expect(nav.refresh).not.toHaveBeenCalled();
  });

  it("when the caller may assign nothing else, the dialog says so and cannot be submitted", async () => {
    renderTeam({ assignableRoles: [{ id: ROLE_PERSONEL, name: "Personel" }] });
    const dialog = await openRoleDialog("Fatma Personel");
    expect(within(dialog).getByText(A.roleDialog.noRoles)).toBeTruthy();
    expect(within(dialog).queryByRole("combobox")).toBeNull();
    expect((within(dialog).getByRole("button", { name: A.roleDialog.submit }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("nothing carries over between members: a role picked for one person is not pre-selected for the next", async () => {
    renderTeam();
    let dialog = await openRoleDialog("Fatma Personel");
    await chooseRole(dialog, "Resepsiyon");
    expect((within(dialog).getByRole("button", { name: A.roleDialog.submit }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(within(dialog).getByRole("button", { name: A.roleDialog.cancel }));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());

    dialog = await openRoleDialog("Gül Askıda");
    expect((within(dialog).getByRole("button", { name: A.roleDialog.submit }) as HTMLButtonElement).disabled).toBe(true);
    expect(mockedChangeRole).not.toHaveBeenCalled();
  });
});
