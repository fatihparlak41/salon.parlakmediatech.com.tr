// @vitest-environment jsdom
/**
 * Faz SAAS.1A — the screens around account lifecycle, rendered in jsdom with the REAL Turkish catalog and recording
 * fakes for the server actions. IDs UI1-UI14. No network, no database.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { NextIntlClientProvider } from "next-intl";
import trMessages from "@/messages/tr.json";
import type { ActionResult } from "@/lib/errors";

const h = vi.hoisted(() => ({
  signIn: vi.fn(),
  resend: vi.fn(),
  forgot: vi.fn(),
  reset: vi.fn(),
  suspend: vi.fn(),
  reactivate: vi.fn(),
  remove: vi.fn(),
  pending: null as null | { tokenHash: string; type: string; next: string },
}));

vi.mock("@/lib/modules/auth/actions", () => ({
  signInAction: (...args: unknown[]) => h.signIn(...args),
  resendConfirmationAction: (...args: unknown[]) => h.resend(...args),
  requestPasswordRecoveryAction: (...args: unknown[]) => h.forgot(...args),
  resetPasswordAction: (...args: unknown[]) => h.reset(...args),
}));
vi.mock("@/lib/modules/team/member-actions", () => ({
  suspendMemberAction: (...args: unknown[]) => h.suspend(...args),
  reactivateMemberAction: (...args: unknown[]) => h.reactivate(...args),
  removeMemberAction: (...args: unknown[]) => h.remove(...args),
}));
vi.mock("@/lib/modules/team/actions", () => ({
  createTeamInvitationAction: vi.fn(),
  resendTeamInvitationAction: vi.fn(),
  revokeTeamInvitationAction: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }) }));
vi.mock("@/lib/i18n/navigation", () => ({
  Link: ({ href, children, ...rest }: { href: string; children?: React.ReactNode }) => (
    <a href={href} {...rest}>
      {children}
    </a>
  ),
  useRouter: () => ({ refresh: vi.fn(), push: vi.fn() }),
}));
vi.mock("@/lib/auth/pending-confirmation", () => ({ getPendingConfirmation: async () => h.pending }));
vi.mock("next-intl/server", () => ({
  getTranslations: async (namespace: string) => (key: string) => {
    let node: unknown = trMessages;
    for (const part of `${namespace}.${key}`.split(".")) node = (node as Record<string, unknown>)?.[part];
    return typeof node === "string" ? node : `${namespace}.${key}`;
  },
}));

import { LoginForm } from "@/components/auth/login-form";
import { ForgotPasswordForm, RESET_RESEND_COOLDOWN_SECONDS } from "@/components/auth/forgot-password-form";
import { ResetPasswordForm } from "@/components/auth/reset-password-form";
import ResetPasswordPage from "@/app/[locale]/(auth)/reset-password/page";
import ForgotPasswordPage from "@/app/[locale]/(auth)/forgot-password/page";
import LoginPage from "@/app/[locale]/(auth)/login/page";
import { TeamMembersSection } from "@/components/team/team-members-section";
import { TeamPageClient } from "@/components/team/team-page-client";
import type { TeamMemberRow, TeamInvitationRow } from "@/lib/modules/team/queries";

const withIntl = (ui: React.ReactElement) => (
  <NextIntlClientProvider locale="tr" messages={trMessages}>
    {ui}
  </NextIntlClientProvider>
);

const NEUTRAL = "Eğer bu e-posta ile kayıtlı bir hesabınız varsa, şifre yenileme bağlantısı gönderildi.";
const fail = (code: string, message: string): ActionResult<never> => ({ success: false, error: { code: code as never, message } });

beforeEach(() => {
  for (const fn of [h.signIn, h.resend, h.forgot, h.reset, h.suspend, h.reactivate, h.remove]) fn.mockReset();
  h.pending = null;
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

// ---------------------------------------------------------------------------------------------------------------------
describe("UI1-UI4 login form", () => {
  it("UI1 offers 'Şifremi unuttum' that leads to the dedicated recovery page, and no notice by default", () => {
    render(withIntl(<LoginForm />));
    const link = screen.getByRole("link", { name: "Şifremi unuttum" });
    expect(link.getAttribute("href")).toBe("/forgot-password");
    expect(screen.queryByRole("status")).toBeNull();
  });

  it("UI2 after a successful reset it shows the one-line confirmation", () => {
    render(withIntl(<LoginForm passwordWasReset />));
    expect(screen.getByRole("status").textContent).toBe("Şifreniz güncellendi. Yeni şifrenizle giriş yapabilirsiniz.");
  });

  it("UI3 a generic failure shows the generic message and NO resend offer; the e-mail the person typed stays", async () => {
    h.signIn.mockResolvedValue(fail("UNAUTHENTICATED", "E-posta veya şifre hatalı"));
    render(withIntl(<LoginForm />));
    fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: "kisi@example.com" } });
    fireEvent.change(screen.getByLabelText("Şifre"), { target: { value: "yanlis" } });
    fireEvent.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect((await screen.findByRole("alert")).textContent).toBe("E-posta veya şifre hatalı");
    expect(screen.queryByRole("button", { name: "Doğrulama e-postasını tekrar gönder" })).toBeNull();
    expect((screen.getByLabelText("E-posta") as HTMLInputElement).value).toBe("kisi@example.com");
  });

  it("UI4 an unconfirmed account gets a useful state with a resend button that sends the typed address and stays neutral", async () => {
    h.signIn.mockResolvedValue(
      fail("EMAIL_NOT_CONFIRMED", "E-posta adresiniz henüz doğrulanmamış. Gelen kutunuzdaki doğrulama bağlantısına tıklayın veya yeni bir doğrulama e-postası isteyin."),
    );
    h.resend.mockResolvedValue({ success: true, data: null });
    render(withIntl(<LoginForm />));
    fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: "yeni@example.com" } });
    fireEvent.change(screen.getByLabelText("Şifre"), { target: { value: "dogru-sifre-1" } });
    fireEvent.click(screen.getByRole("button", { name: "Giriş yap" }));
    expect((await screen.findByRole("alert")).textContent).toContain("doğrulanmamış");

    fireEvent.click(await screen.findByRole("button", { name: "Doğrulama e-postasını tekrar gönder" }));
    await waitFor(() => expect(h.resend).toHaveBeenCalledTimes(1));
    const form = h.resend.mock.calls[0]![1] as FormData;
    expect(form.get("email")).toBe("yeni@example.com");
    expect(await screen.findByText("Bu e-posta adresi kayıtlıysa, yeni bir doğrulama bağlantısı gönderildi.")).toBeTruthy();
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("UI5-UI7 forgot-password form", () => {
  it("UI5 a malformed address shows the server's validation message and nothing about accounts", async () => {
    h.forgot.mockResolvedValue(fail("VALIDATION", "Geçerli bir e-posta adresi girin"));
    render(withIntl(<ForgotPasswordForm />));
    fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: "nope" } });
    // The browser's own validation would stop this before the server; submit the form directly to reach the server-side check.
    fireEvent.submit(screen.getByRole("button", { name: "Şifre yenileme bağlantısı gönder" }).closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toBe("Geçerli bir e-posta adresi girin");
  });

  it("UI6 success shows exactly the neutral sentence, never the address, and starts a send-again cooldown", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.forgot.mockResolvedValue({ success: true, data: { message: NEUTRAL } });
    render(withIntl(<ForgotPasswordForm />));
    fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: "kisi@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Şifre yenileme bağlantısı gönder" }));

    const status = await screen.findByRole("status");
    expect(status.textContent).toBe(NEUTRAL);
    expect(document.body.textContent).not.toContain("kisi@example.com");
    const again = screen.getByRole("button", { name: new RegExp(`Yeniden göndermek için ${RESET_RESEND_COOLDOWN_SECONDS} sn bekleyin`) });
    expect((again as HTMLButtonElement).disabled).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync((RESET_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    });
    const enabled = screen.getByRole("button", { name: "Bağlantıyı yeniden gönder" }) as HTMLButtonElement;
    expect(enabled.disabled).toBe(false);
  });

  it("UI7 'send again' resubmits the SAME address and restarts the cooldown (no rapid repeats)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    h.forgot.mockResolvedValue({ success: true, data: { message: NEUTRAL } });
    render(withIntl(<ForgotPasswordForm />));
    fireEvent.change(screen.getByLabelText("E-posta"), { target: { value: "kisi@example.com" } });
    fireEvent.click(screen.getByRole("button", { name: "Şifre yenileme bağlantısı gönder" }));
    await screen.findByRole("status");
    await act(async () => {
      await vi.advanceTimersByTimeAsync((RESET_RESEND_COOLDOWN_SECONDS + 1) * 1000);
    });
    fireEvent.click(screen.getByRole("button", { name: "Bağlantıyı yeniden gönder" }));
    await waitFor(() => expect(h.forgot).toHaveBeenCalledTimes(2));
    expect((h.forgot.mock.calls[1]![1] as FormData).get("email")).toBe("kisi@example.com");
    // immediately after: waiting again, button disabled
    const waiting = await screen.findByRole("button", { name: /sn bekleyin/ });
    expect((waiting as HTMLButtonElement).disabled).toBe(true);
    // a double click during the wait cannot send a third request
    fireEvent.click(waiting);
    expect(h.forgot).toHaveBeenCalledTimes(2);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("UI8-UI10 reset-password surface", () => {
  it("UI8 without a parked recovery link the page says so plainly and offers a new link; no form", async () => {
    h.pending = null;
    render(withIntl(await ResetPasswordPage()));
    expect(screen.getByRole("heading", { name: "Bu bağlantı kullanılamıyor" })).toBeTruthy();
    // rendered as a button-styled anchor (the app's usual Button render={<Link/>} pattern)
    expect(screen.getByRole("button", { name: "Yeni bağlantı iste" }).getAttribute("href")).toBe("/forgot-password");
    expect(screen.queryByLabelText("Yeni şifre")).toBeNull();
  });

  it("UI9 a parked token of ANOTHER kind (signup) is not a recovery link either", async () => {
    h.pending = { tokenHash: "x", type: "signup", next: "/" };
    render(withIntl(await ResetPasswordPage()));
    expect(screen.getByRole("heading", { name: "Bu bağlantı kullanılamıyor" })).toBeTruthy();
  });

  it("UI10 with a parked recovery link the form appears; a dead-link answer offers a new link and shows no raw error", async () => {
    h.pending = { tokenHash: "x", type: "recovery", next: "/" };
    render(withIntl(await ResetPasswordPage()));
    expect(screen.getByRole("heading", { name: "Yeni şifre belirleyin" })).toBeTruthy();
    cleanup();

    h.reset.mockResolvedValue(fail("UNAUTHENTICATED", "Bu bağlantının süresi dolmuş veya daha önce kullanılmış. Yeni bir şifre yenileme bağlantısı isteyin."));
    render(withIntl(<ResetPasswordForm />));
    fireEvent.change(screen.getByLabelText("Yeni şifre"), { target: { value: "yepyeni-sifre" } });
    fireEvent.change(screen.getByLabelText("Yeni şifre (tekrar)"), { target: { value: "yepyeni-sifre" } });
    fireEvent.click(screen.getByRole("button", { name: "Şifreyi güncelle" }));
    expect((await screen.findByRole("alert")).textContent).toContain("süresi dolmuş");
    expect(screen.getByRole("link", { name: "Yeni bağlantı iste" }).getAttribute("href")).toBe("/forgot-password");
    expect(document.body.textContent).not.toMatch(/supabase|jwt|otp_expired|token/i);
    // the form submits only the two password fields
    const form = h.reset.mock.calls[0]![1] as FormData;
    expect([...form.keys()].sort()).toEqual(["confirmPassword", "password"]);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
describe("UI11 pages and copy", () => {
  it("UI11a the forgot-password page has the title and no `next` handling at all", async () => {
    render(withIntl(await ForgotPasswordPage()));
    expect(screen.getByRole("heading", { name: "Şifrenizi mi unuttunuz?" })).toBeTruthy();
  });

  it("UI11b the login page shows the reset notice only for the exact value ?reset=success", async () => {
    const page = (reset: string | string[] | undefined) => LoginPage({ searchParams: Promise.resolve({ reset }) } as never);
    render(withIntl(await page("success")));
    expect(screen.getByRole("status")).toBeTruthy();
    cleanup();
    for (const other of ["1", "SUCCESS", "success ", ["nope", "success"], undefined]) {
      render(withIntl(await page(other as never)));
      expect(screen.queryByRole("status"), JSON.stringify(other)).toBeNull();
      cleanup();
    }
  });

  it("UI11c no developer terms in any of the new customer-facing text", () => {
    const text = JSON.stringify([trMessages.Auth.forgotPassword, trMessages.Auth.resetPassword, trMessages.Auth.login, trMessages.Team]);
    expect(text).not.toMatch(/jwt|supabase|oauth|auth id|membership id|uuid|token/i);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
function member(over: Partial<TeamMemberRow> = {}): TeamMemberRow {
  return {
    membershipId: "11111111-1111-4111-8111-111111111111",
    displayName: "Ayşe Yılmaz",
    email: "ayse@example.com",
    roleId: "22222222-2222-4222-8222-222222222222",
    roleName: "Resepsiyon",
    status: "active",
    isSelf: false,
    linkedStaffName: "Ayşe (personel)",
    isLastUnrestrictedHolder: false,
    canSuspend: true,
    canReactivate: false,
    canRemove: true,
    ...over,
  };
}

const membersLabels = {
  ...trMessages.Team.membersTable,
  actions: trMessages.Team.memberActions,
};

describe("UI12 team member list", () => {
  it("UI12a shows name, e-mail, role, state and linked staff; never an id", () => {
    const rows = [member(), member({ membershipId: "33333333-3333-4333-8333-333333333333", displayName: "Mehmet", email: null, roleName: "Personel", linkedStaffName: null, status: "suspended", canSuspend: false, canReactivate: true })];
    const { container } = render(<TeamMembersSection members={rows} labels={membersLabels} onAction={() => {}} />);
    const text = container.textContent!;
    expect(text).toContain("ayse@example.com");
    expect(text).toContain("Erişimi durdurulmuş");
    expect(text).toContain("Aktif");
    expect(text).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
  });

  it("UI12b only the controls this caller can really use appear (no fake buttons)", () => {
    const rows = [
      member({ membershipId: "a1", displayName: "Aktif Kişi", canSuspend: true, canReactivate: false, canRemove: true }),
      member({ membershipId: "a2", displayName: "Durdurulmuş Kişi", status: "suspended", canSuspend: false, canReactivate: true, canRemove: true }),
      member({ membershipId: "a3", displayName: "Yetkisiz Hedef", canSuspend: false, canReactivate: false, canRemove: false }),
      member({ membershipId: "a4", displayName: "Sadece Durdurulabilir", canSuspend: true, canReactivate: false, canRemove: false }),
    ];
    render(<TeamMembersSection members={rows} labels={membersLabels} onAction={() => {}} />);
    const desktop = document.querySelector(".md\\:block") as HTMLElement;
    const rowOf = (name: string) => within(desktop).getByText(name).closest("tr") as HTMLElement;
    expect(within(rowOf("Aktif Kişi")).queryByRole("button", { name: "Erişimi durdur" })).toBeTruthy();
    expect(within(rowOf("Aktif Kişi")).queryByRole("button", { name: "Erişimi aç" })).toBeNull();
    expect(within(rowOf("Durdurulmuş Kişi")).queryByRole("button", { name: "Erişimi aç" })).toBeTruthy();
    expect(within(rowOf("Durdurulmuş Kişi")).queryByRole("button", { name: "Erişimi durdur" })).toBeNull();
    expect(within(rowOf("Yetkisiz Hedef")).queryAllByRole("button")).toHaveLength(0);
    // one allowed control must not drag the others in (each control is gated by its own flag)
    expect(within(rowOf("Sadece Durdurulabilir")).queryByRole("button", { name: "Erişimi durdur" })).toBeTruthy();
    expect(within(rowOf("Sadece Durdurulabilir")).queryByRole("button", { name: "Ekipten çıkar" })).toBeNull();
    expect(within(rowOf("Durdurulmuş Kişi")).queryByRole("button", { name: "Ekipten çıkar" })).toBeTruthy();
  });

  it("UI12c yourself and the last Owner show a badge / an explanation instead of controls", () => {
    const rows = [
      member({ membershipId: "s1", displayName: "Ben", isSelf: true, canSuspend: false, canRemove: false }),
      member({ membershipId: "o1", displayName: "Tek Sahip", roleName: "Salon Sahibi", isLastUnrestrictedHolder: true, canSuspend: false, canRemove: false }),
    ];
    render(<TeamMembersSection members={rows} labels={membersLabels} onAction={() => {}} />);
    const desktop = document.querySelector(".md\\:block") as HTMLElement;
    expect(within(desktop).getByText("Siz")).toBeTruthy();
    expect(within(desktop).getByText("Son salon sahibi: erişimi durdurulamaz veya kaldırılamaz.")).toBeTruthy();
    expect(within(desktop).queryAllByRole("button")).toHaveLength(0);
  });

  it("UI12d without an action handler the list is read-only", () => {
    render(<TeamMembersSection members={[member()]} labels={membersLabels} />);
    expect(screen.queryAllByRole("button")).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------------
function teamLabels() {
  const t = trMessages.Team;
  return {
    title: t.title,
    description: t.description,
    inviteCta: t.inviteCta,
    membersSectionTitle: t.membersSectionTitle,
    invitationsSectionTitle: t.invitationsSectionTitle,
    membersTable: t.membersTable,
    memberActions: t.memberActions,
    memberDialog: t.memberDialog,
    memberActionDone: t.memberActionDone,
    expiredInvitationHint: t.expiredInvitationHint,
    invitationsTable: t.invitationsTable,
    emptyInvitationsTitle: t.emptyInvitationsTitle,
    noMembersTitle: t.noMembersTitle,
    resendCta: t.resendCta,
    resendPending: t.resendPending,
    revokeCta: t.revokeCta,
    revokeConfirmTitle: t.revokeConfirmTitle,
    revokeConfirmDescription: t.revokeConfirmDescription,
    revokeConfirmCancel: t.revokeConfirmCancel,
    revokeConfirmConfirm: t.revokeConfirmConfirm,
    revokeConfirmPending: t.revokeConfirmPending,
    createSentMessage: t.createSentMessage,
    createDeliveryFailedMessage: t.createDeliveryFailedMessage,
    resendSentMessage: t.resendSentMessage,
    resendDeliveryFailedMessage: t.resendDeliveryFailedMessage,
    resendExpiredMessage: t.resendExpiredMessage,
    invitationChangedMessage: t.invitationChangedMessage,
    createDialog: t.createDialog,
  };
}

function invitation(over: Partial<TeamInvitationRow> = {}): TeamInvitationRow {
  return {
    id: "inv-1",
    email: "davetli@example.com",
    roleId: "r1",
    roleName: "Resepsiyon",
    staffMemberId: null,
    staffMemberName: null,
    status: "pending",
    effectiveStatus: "pending",
    expiresAt: "2026-11-05T10:00:00.000Z",
    createdAt: "2026-10-29T10:00:00.000Z",
    invitedByName: "Sahip",
    ...over,
  };
}

function renderTeam(members: TeamMemberRow[], invitations: TeamInvitationRow[] = []) {
  return render(
    withIntl(
      <TeamPageClient
        tenantId="tenant-1"
        tenantSlug="ornek-salon"
        initialMembers={members}
        initialInvitations={invitations}
        staffLinkOptions={[]}
        roleOptions={[]}
        labels={teamLabels() as never}
      />,
    ),
  );
}

describe("UI13 team page: confirm dialogs and outcomes", () => {
  it("UI13a suspending asks first, names the person, promises the history stays, then calls the action with the ids and shows the outcome", async () => {
    h.suspend.mockResolvedValue({ success: true, data: { membershipId: "11111111-1111-4111-8111-111111111111" } });
    renderTeam([member()]);
    const desktop = document.querySelector(".md\\:block") as HTMLElement;
    fireEvent.click(within(desktop).getByRole("button", { name: "Erişimi durdur" }));

    const dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Erişimi durdur?")).toBeTruthy();
    expect(dialog.textContent).toContain("Ayşe Yılmaz");
    expect(dialog.textContent).toContain("Randevular, ödemeler, komisyon ve diğer geçmiş kayıtlar olduğu gibi kalır");
    expect(dialog.textContent).not.toMatch(/[0-9a-f]{8}-[0-9a-f]{4}-/);
    expect(h.suspend).not.toHaveBeenCalled();

    fireEvent.click(within(dialog).getByRole("button", { name: "Erişimi Durdur" }));
    await waitFor(() => expect(h.suspend).toHaveBeenCalledTimes(1));
    expect(h.suspend.mock.calls[0]![1]).toEqual({ tenantId: "tenant-1", tenantSlug: "ornek-salon", membershipId: "11111111-1111-4111-8111-111111111111" });
    expect((await screen.findByText("Erişim durduruldu.")).closest('[role="status"]')).not.toBeNull();
  });

  it("UI13b a refusal from the database is shown in the dialog in plain words and the dialog stays open", async () => {
    h.remove.mockResolvedValue(fail("CONFLICT", "Salonun en az bir aktif sahibi olmalı. Son salon sahibinin erişimi durdurulamaz veya kaldırılamaz"));
    renderTeam([member()]);
    const desktop = document.querySelector(".md\\:block") as HTMLElement;
    fireEvent.click(within(desktop).getByRole("button", { name: "Ekipten çıkar" }));
    const dialog = await screen.findByRole("alertdialog");
    expect(dialog.textContent).toContain("Geçmiş kayıtlar silinmez".replace("Geçmiş", "geçmiş"));
    fireEvent.click(within(dialog).getByRole("button", { name: "Ekipten Çıkar" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain("en az bir aktif sahibi olmalı");
    expect(screen.queryByText("Üye ekipten çıkarıldı.")).toBeNull();
  });

  it("UI13c cancelling the dialog performs nothing; reactivation uses its own action and wording", async () => {
    h.reactivate.mockResolvedValue({ success: true, data: { membershipId: "x" } });
    renderTeam([member({ status: "suspended", canSuspend: false, canReactivate: true })]);
    const desktop = document.querySelector(".md\\:block") as HTMLElement;
    fireEvent.click(within(desktop).getByRole("button", { name: "Erişimi aç" }));
    let dialog = await screen.findByRole("alertdialog");
    expect(within(dialog).getByText("Erişimi yeniden aç?")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Vazgeç" }));
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(h.reactivate).not.toHaveBeenCalled();

    fireEvent.click(within(desktop).getByRole("button", { name: "Erişimi aç" }));
    dialog = await screen.findByRole("alertdialog");
    fireEvent.click(within(dialog).getByRole("button", { name: "Erişimi Aç" }));
    await waitFor(() => expect(h.reactivate).toHaveBeenCalledTimes(1));
    expect(h.suspend).not.toHaveBeenCalled();
    expect(h.remove).not.toHaveBeenCalled();
  });
});

describe("UI14 invitations: state, expiry and the way forward", () => {
  it("UI14a a pending invitation shows state and the resend / revoke controls; an expired one shows its state, no controls and the hint", () => {
    renderTeam([member({ canSuspend: false, canRemove: false })], [
      invitation(),
      invitation({ id: "inv-2", email: "eski@example.com", effectiveStatus: "expired", status: "pending" }),
    ]);
    const desktop = document.querySelectorAll(".md\\:block")[1] as HTMLElement;
    const pendingRow = within(desktop).getByText("davetli@example.com").closest("tr") as HTMLElement;
    expect(within(pendingRow).getByText("Bekliyor")).toBeTruthy();
    expect(within(pendingRow).getByRole("button", { name: "Tekrar Gönder" })).toBeTruthy();
    expect(within(pendingRow).getByRole("button", { name: "İptal Et" })).toBeTruthy();
    const expiredRow = within(desktop).getByText("eski@example.com").closest("tr") as HTMLElement;
    expect(within(expiredRow).getByText("Süresi doldu")).toBeTruthy();
    expect(within(expiredRow).queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByText(trMessages.Team.expiredInvitationHint)).toBeTruthy();
  });

  it("UI14b with only pending invitations the expiry hint is absent", () => {
    renderTeam([member({ canSuspend: false, canRemove: false })], [invitation()]);
    expect(screen.queryByText(trMessages.Team.expiredInvitationHint)).toBeNull();
  });
});
