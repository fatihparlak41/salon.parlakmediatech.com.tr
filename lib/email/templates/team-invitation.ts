import { utcIsoToTenantLocalParts } from "@/lib/modules/appointments/timezone";

/**
 * Faz SAAS.1C.2B — the real Turkish team-invitation email content. Pure
 * by design: no Resend import, no Supabase import, no env reads, no DB
 * access, no console logging. Every value it renders is passed in by
 * the caller (lib/modules/team/actions.ts); this module only knows how
 * to turn that data into {subject, html, text}.
 *
 * tenantTimezone is not part of the phase's own suggested input
 * "concept" — added as a small, justified difference: a bare
 * `expiresAt: Date` is a UTC instant, and rendering it in a specific
 * tenant's local time (required — never invent a timezone, never
 * silently show UTC) needs to know which timezone. tenants.timezone
 * exists in the schema (confirmed fresh, not assumed) and is exactly
 * what lib/modules/appointments/timezone.ts's own tenant-local
 * conversion primitive already expects everywhere else in this
 * codebase.
 */
export type TeamInvitationTemplateInput = {
  tenantName: string;
  roleName: string;
  inviterName: string | null;
  acceptUrl: string;
  expiresAt: Date;
  tenantTimezone: string;
  locale: "tr";
};

export type TeamInvitationEmailContent = {
  subject: string;
  html: string;
  text: string;
};

const TR_MONTH_NAMES = [
  "Ocak", "Şubat", "Mart", "Nisan", "Mayıs", "Haziran",
  "Temmuz", "Ağustos", "Eylül", "Ekim", "Kasım", "Aralık",
] as const;

/** "7 Ekim 2026, 14:30" — full month name and year (unlike the more
 * abbreviated push-notification date format elsewhere in this project):
 * an invitation email may be read at any point within its week-long
 * validity, or found again later in an inbox search well after it
 * expired, so it should read unambiguously on its own rather than
 * assuming "now" context the way a push notification can. Reuses
 * utcIsoToTenantLocalParts, the same DST-correct Intl-based primitive
 * every other tenant-local time display in this codebase already uses —
 * not reimplemented here. */
function formatTurkishExpiry(expiresAt: Date, tenantTimezone: string): string {
  const { date, time } = utcIsoToTenantLocalParts(expiresAt.toISOString(), tenantTimezone);
  const [yearStr, monthStr, dayStr] = date.split("-");
  const day = String(Number(dayStr));
  const month = TR_MONTH_NAMES[Number(monthStr) - 1];
  return `${day} ${month} ${yearStr}, ${time}`;
}

/** Standard HTML entity escaping for every database-controlled value
 * interpolated into the HTML body — tenantName, roleName, inviterName,
 * and acceptUrl (both as the href attribute value and as the visible
 * fallback link text). Applied uniformly regardless of today's actual
 * token character set (hex-only) — this must hold even if that ever
 * changes, per this phase's own instruction. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

export function buildTeamInvitationEmail(input: TeamInvitationTemplateInput): TeamInvitationEmailContent {
  const expiryDisplay = formatTurkishExpiry(input.expiresAt, input.tenantTimezone);
  const subject = `${input.tenantName} sizi SalonOS'a davet etti`;

  const tenantNameHtml = escapeHtml(input.tenantName);
  const roleNameHtml = escapeHtml(input.roleName);
  const acceptUrlHtml = escapeHtml(input.acceptUrl);
  const inviterLineHtml = input.inviterName
    ? `<p><strong>${escapeHtml(input.inviterName)}</strong>, sizi SalonOS'ta bu salona katılmaya davet etti.</p>`
    : `<p>Sizi SalonOS'ta bu salona katılmaya davet ettiler.</p>`;

  const html = `<!DOCTYPE html>
<html lang="tr">
  <body style="font-family: sans-serif; color: #1a1a1a; line-height: 1.5;">
    <p><strong>SalonOS</strong></p>
    <p><strong>${tenantNameHtml}</strong> sizi SalonOS'a davet etti.</p>
    ${inviterLineHtml}
    <p>Rol: <strong>${roleNameHtml}</strong></p>
    <p>Bu davet <strong>${expiryDisplay}</strong> tarihinde sona erecek.</p>
    <p>
      <a href="${acceptUrlHtml}" style="display: inline-block; padding: 10px 20px; background: #111827; color: #ffffff; text-decoration: none; border-radius: 6px;">
        Daveti Kabul Et
      </a>
    </p>
    <p>Buton çalışmazsa aşağıdaki bağlantıyı tarayıcınıza yapıştırabilirsiniz:</p>
    <p><a href="${acceptUrlHtml}">${acceptUrlHtml}</a></p>
    <p style="color: #6b7280; font-size: 13px;">Bu daveti beklemiyorsanız bu e-postayı yoksayabilirsiniz.</p>
  </body>
</html>`;

  const inviterLineText = input.inviterName
    ? `${input.inviterName}, sizi SalonOS'ta bu salona katılmaya davet etti.`
    : "Sizi SalonOS'ta bu salona katılmaya davet ettiler.";

  const text = [
    "SalonOS",
    "",
    `${input.tenantName} sizi SalonOS'a davet etti.`,
    inviterLineText,
    `Rol: ${input.roleName}`,
    `Bu davet ${expiryDisplay} tarihinde sona erecek.`,
    "",
    "Daveti kabul etmek için:",
    input.acceptUrl,
    "",
    "Bu daveti beklemiyorsanız bu e-postayı yoksayabilirsiniz.",
  ].join("\n");

  return { subject, html, text };
}
