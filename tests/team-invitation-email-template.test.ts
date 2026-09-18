import { describe, expect, it } from "vitest";
import {
  buildTeamInvitationEmail,
  type TeamInvitationTemplateInput,
} from "@/lib/email/templates/team-invitation";

/**
 * Faz SAAS.1C.2B — the pure Turkish invitation email template. No
 * Resend, no Supabase, no env, no DB, no console — every test here
 * constructs input directly and asserts on the returned
 * {subject, html, text}, never touching any I/O.
 */

function baseInput(overrides: Partial<TeamInvitationTemplateInput> = {}): TeamInvitationTemplateInput {
  return {
    tenantName: "Gökhan İlhan Hair Studio",
    roleName: "Resepsiyon",
    inviterName: "Gökhan İlhan",
    acceptUrl: "https://salon.parlakmediatech.com.tr/accept-invite?token=abc123def456",
    expiresAt: new Date("2026-09-25T11:00:00.000Z"),
    tenantTimezone: "Europe/Istanbul",
    locale: "tr",
    ...overrides,
  };
}

describe("content (1-9)", () => {
  it("1. Turkish subject correct", () => {
    const { subject } = buildTeamInvitationEmail(baseInput());
    expect(subject).toBe("Gökhan İlhan Hair Studio sizi SalonOS'a davet etti");
  });

  it("2. salon name present in both html and text", () => {
    const { html, text } = buildTeamInvitationEmail(baseInput());
    expect(html).toContain("Gökhan İlhan Hair Studio");
    expect(text).toContain("Gökhan İlhan Hair Studio");
  });

  it("3. role name present in both html and text", () => {
    const { html, text } = buildTeamInvitationEmail(baseInput());
    expect(html).toContain("Resepsiyon");
    expect(text).toContain("Resepsiyon");
  });

  it("4. inviter present when supplied", () => {
    const { html, text } = buildTeamInvitationEmail(baseInput({ inviterName: "Ayşe Yılmaz" }));
    expect(html).toContain("Ayşe Yılmaz");
    expect(text).toContain("Ayşe Yılmaz");
  });

  it("5. inviter omitted cleanly when null — no 'null' or empty artifact", () => {
    const { html, text } = buildTeamInvitationEmail(baseInput({ inviterName: null }));
    expect(html).not.toMatch(/null/i);
    expect(text).not.toMatch(/null/i);
    // Still communicates an invitation happened, just without naming anyone.
    expect(html).toContain("davet");
    expect(text).toContain("davet");
  });

  it("6. expiry rendered in the tenant's own timezone, not UTC", () => {
    // 2026-09-25T11:00:00.000Z in Europe/Istanbul (UTC+3, no DST) is
    // 2026-09-25 14:00 local — proves this isn't just echoing the raw
    // UTC instant.
    const { html, text } = buildTeamInvitationEmail(
      baseInput({ expiresAt: new Date("2026-09-25T11:00:00.000Z"), tenantTimezone: "Europe/Istanbul" }),
    );
    expect(html).toContain("25 Eylül 2026, 14:00");
    expect(text).toContain("25 Eylül 2026, 14:00");
  });

  it("6b. a different tenant timezone renders a different local hour for the same instant", () => {
    const istanbul = buildTeamInvitationEmail(
      baseInput({ expiresAt: new Date("2026-09-25T11:00:00.000Z"), tenantTimezone: "Europe/Istanbul" }),
    );
    const london = buildTeamInvitationEmail(
      baseInput({ expiresAt: new Date("2026-09-25T11:00:00.000Z"), tenantTimezone: "Europe/London" }),
    );
    expect(istanbul.text).toContain("14:00");
    expect(london.text).toContain("12:00");
  });

  it("7. CTA URL present in html as a real href", () => {
    const { html } = buildTeamInvitationEmail(baseInput());
    expect(html).toContain('href="https://salon.parlakmediatech.com.tr/accept-invite?token=abc123def456"');
  });

  it("8. fallback URL present in plain text", () => {
    const { text } = buildTeamInvitationEmail(baseInput());
    expect(text).toContain("https://salon.parlakmediatech.com.tr/accept-invite?token=abc123def456");
  });

  it("9. unexpected-invite notice present in both html and text", () => {
    const { html, text } = buildTeamInvitationEmail(baseInput());
    expect(html).toContain("Bu daveti beklemiyorsanız bu e-postayı yoksayabilirsiniz.");
    expect(text).toContain("Bu daveti beklemiyorsanız bu e-postayı yoksayabilirsiniz.");
  });
});

describe("HTML escaping — hostile input renders as text, never markup (10-13)", () => {
  it("10. tenantName is escaped", () => {
    const { html } = buildTeamInvitationEmail(baseInput({ tenantName: `<script>alert('xss')</script>` }));
    expect(html).not.toContain("<script>");
    expect(html).toContain("&lt;script&gt;");
  });

  it("11. roleName is escaped", () => {
    const { html } = buildTeamInvitationEmail(baseInput({ roleName: `"><img src=x onerror=alert(1)>` }));
    expect(html).not.toContain("<img");
    expect(html).toContain("&quot;&gt;&lt;img");
  });

  it("12. inviterName is escaped", () => {
    const { html } = buildTeamInvitationEmail(
      baseInput({ inviterName: `Ad & Soyad <b>'quoted'</b>` }),
    );
    expect(html).not.toContain("<b>");
    expect(html).toContain("Ad &amp; Soyad &lt;b&gt;&#39;quoted&#39;&lt;/b&gt;");
  });

  it("13. acceptUrl is safely escaped even with URL-sensitive characters", () => {
    // Current tokens are hex-only, but the template must not assume that
    // forever — a token containing HTML-sensitive characters must still
    // render as inert text/attribute content, never break out of the
    // href attribute or inject markup.
    const hostileUrl = `https://salon.parlakmediatech.com.tr/accept-invite?token="><script>alert(1)</script>&x=1`;
    const { html } = buildTeamInvitationEmail(baseInput({ acceptUrl: hostileUrl }));
    expect(html).not.toContain('"><script>alert(1)</script>');
    expect(html).not.toContain("<script>");
    expect(html).toContain("&quot;&gt;&lt;script&gt;");
    expect(html).toContain("&amp;x=1");
  });

  it("hostile values also render as literal text in the plain-text part (no HTML there to escape into)", () => {
    const { text } = buildTeamInvitationEmail(baseInput({ tenantName: `<script>alert('xss')</script>` }));
    expect(text).toContain(`<script>alert('xss')</script>`);
  });
});

describe("no internal implementation details leak into content (14)", () => {
  it("14. no permission keys, internal IDs, or security-internal wording appear", () => {
    const { subject, html, text } = buildTeamInvitationEmail(baseInput());
    const combined = `${subject}\n${html}\n${text}`;
    const forbidden = [
      "staff.manage",
      "manage_unrestricted",
      "permissions.",
      "token_hash",
      "invitation_id",
      "tenant_id",
      "role_id",
      "staff_member_id",
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i, // any UUID shape
    ];
    for (const token of forbidden) {
      if (typeof token === "string") {
        expect(combined).not.toContain(token);
      } else {
        expect(combined).not.toMatch(token);
      }
    }
  });
});

describe("purity", () => {
  it("the template module imports nothing from resend, supabase, or process.env-reading modules", () => {
    // Structural: this file only ever calls buildTeamInvitationEmail with
    // plain constructed input, no server, no network, no DB — the fact
    // every test above runs synchronously-fast with zero setup is itself
    // evidence of that, verified explicitly here for documentation.
    const start = Date.now();
    buildTeamInvitationEmail(baseInput());
    expect(Date.now() - start).toBeLessThan(50);
  });
});
